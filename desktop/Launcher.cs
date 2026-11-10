using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;

[assembly: System.Reflection.AssemblyTitle("Chengmeng")]
[assembly: System.Reflection.AssemblyProduct("Chengmeng")]
[assembly: System.Reflection.AssemblyVersion("0.5.0.0")]
internal static class Launcher {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly Dictionary<string,string> Options = new Dictionary<string,string>();
    static ProgressWindow Window;
    static string InstallRoot, DataHome, LogFile;
    static bool Quiet, Isolated;
    static int Result;
    [STAThread] static int Main(string[] args) {
        try {
            // Enable modern .NET path normalization without changing Windows
            // registry settings. Bundled Python packages contain long paths.
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            for (int i=0;i<args.Length;i++) {
                string key=args[i];
                if (key=="--data-home" || key=="--install-root") {
                    if (++i>=args.Length) throw new Exception("Missing value for " + key);
                    Options[key]=Path.GetFullPath(args[i]);
                } else if (key=="--isolated" || key=="--no-shortcuts" || key=="--prepare-only" || key=="--quiet") Options[key]="1";
                else throw new Exception("Unknown option: " + key);
            }
            Quiet=Options.ContainsKey("--quiet"); Isolated=Options.ContainsKey("--isolated");
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            if (Quiet) Execute();
            else {
                Window=new ProgressWindow();
                Window.Shown+=(s,e)=>Task.Run((Action)Execute).ContinueWith(t=>Ui(()=>Window.Close()));
                Application.Run(Window);
            }
        } catch(Exception error) { Fail(error); }
        return Result;
    }
    static void Ui(Action action) {
        if (Window==null || Window.IsDisposed) return;
        if (Window.InvokeRequired) Window.BeginInvoke(action); else action();
    }
    static void Status(string message, int percent) {
        if (!String.IsNullOrEmpty(LogFile)) File.AppendAllText(LogFile, DateTime.UtcNow.ToString("o")+" "+message+Environment.NewLine, Encoding.UTF8);
        Ui(()=>Window.SetProgress(message, percent));
    }
    static void Fail(Exception error) {
        Result=1;
        if (!String.IsNullOrEmpty(LogFile)) { try { File.AppendAllText(LogFile,error.ToString()+Environment.NewLine,Encoding.UTF8); } catch {} }
        if (!Quiet) MessageBox.Show(error.Message + (LogFile==null?"":"\n\n详细日志："+LogFile),"Chengmeng 启动未完成",MessageBoxButtons.OK,MessageBoxIcon.Error);
    }
    static string HashName(string value) {
        using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value.ToLowerInvariant()))).Replace("-","").Substring(0,24);
    }
    static Dictionary<string,object> ReadJson(string file) {
        try { return Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8)); } catch { return new Dictionary<string,object>(); }
    }
    static string Value(Dictionary<string,object> d,string key) { return d.ContainsKey(key) ? Convert.ToString(d[key]) : null; }
    static void WriteJson(string file, object data) {
        string temp=file+".tmp-"+Process.GetCurrentProcess().Id;
        File.WriteAllText(temp,Json.Serialize(data),new UTF8Encoding(false));
        if(File.Exists(file)) File.Replace(temp,file,null); else File.Move(temp,file);
    }
    static string Quote(string value) {
        var b=new StringBuilder("\""); int slash=0;
        foreach(char c in value) {
            if(c=='\\') { slash++; continue; }
            if(c=='\"') { b.Append('\\',slash*2+1); b.Append(c); }
            else { b.Append('\\',slash); b.Append(c); } slash=0;
        }
        b.Append('\\',slash*2); b.Append('"'); return b.ToString();
    }
    static void Execute() {
        try { Run(); } catch(Exception e) { Fail(e); }
    }
    static void Run() {
        string self=Application.ExecutablePath;
        Payload payload=Payload.TryRead(self);
        InstallRoot=Options.ContainsKey("--install-root")?Options["--install-root"]:
            payload==null?Path.GetDirectoryName(self):Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Chengmeng");
        Directory.CreateDirectory(InstallRoot);
        LogFile=Path.Combine(InstallRoot,"launcher.log");
        string preferenceFile=Path.Combine(InstallRoot,"installation.json");
        var preferences=Isolated?new Dictionary<string,object>():ReadJson(preferenceFile);
        DataHome=Options.ContainsKey("--data-home")?Options["--data-home"]:
            Value(preferences,"dataHome")??Path.Combine(InstallRoot,"data");
        DataHome=Path.GetFullPath(DataHome);
        using(var homeLock=new Mutex(false,"Local\\Chengmeng-home-"+HashName(DataHome))) {
            bool held=false;
            try { held=homeLock.WaitOne(0); } catch(AbandonedMutexException) { held=true; }
            if(!held) {
                if(FocusExisting()) return;
                throw new Exception("同一份 Chengmeng 数据正在启动或初始化，请稍候再打开。");
            }
            try {
                if(FocusExisting()) return;
                CheckOldHost();
                string package;
                using(var installLock=new Mutex(false,"Local\\Chengmeng-install-"+HashName(InstallRoot))) {
                    bool installHeld=false;
                    Status("正在准备 Chengmeng…",0);
                    try { installHeld=installLock.WaitOne(600000); } catch(AbandonedMutexException) { installHeld=true; }
                    if(!installHeld) throw new Exception("另一项安装尚未完成，请稍后重试。");
                    try {
                        package=payload==null?Value(preferences,"currentPackage"):Extract(self,payload);
                        if(String.IsNullOrEmpty(package) || !File.Exists(Path.Combine(package,"prepare.cjs"))) throw new Exception("程序文件不完整，请重新打开完整的 Chengmeng EXE 安装包。");
                        Directory.CreateDirectory(DataHome);
                        Prepare(package);
                        if(!Isolated) {
                            WriteJson(preferenceFile,new { dataHome=DataHome,currentPackage=package,version="0.5.0" });
                            if(payload!=null) InstallStub(self,payload);
                            if(!Options.ContainsKey("--no-shortcuts")) CreateShortcuts();
                        }
                    } finally { installLock.ReleaseMutex(); }
                }
                if(Options.ContainsKey("--prepare-only")) { Status("解包和初始化已完成。",100); return; }
                Status("正在打开 Chengmeng…",100);
                var process=StartDesktop(Path.Combine(package,"app","DeepSeek Harness.exe"));
                Thread.Sleep(1200);
                if(process.HasExited && process.ExitCode!=0) throw new Exception("桌面程序启动失败，退出代码："+process.ExitCode);
                Ui(()=>Window.Hide());
                process.WaitForExit();
            } finally { homeLock.ReleaseMutex(); }
        }
    }
    static void CheckOldHost() {
        var state=ReadJson(Path.Combine(DataHome,"run","host.json"));
        int pid; if(!Int32.TryParse(Value(state,"pid"),out pid)) return;
        try {
            var process=Process.GetProcessById(pid);
            if(!process.HasExited && (process.ProcessName.Equals("powershell",StringComparison.OrdinalIgnoreCase)||process.ProcessName.Equals("pwsh",StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("这份数据的旧版网页服务仍在运行。请先关闭旧服务，再打开桌面版，以免两个服务同时写入记忆。");
        } catch(ArgumentException) {}
    }
    static bool FocusExisting() {
        var state=ReadJson(Path.Combine(DataHome,"run","chengmeng-desktop.json"));
        int pid; if(!Int32.TryParse(Value(state,"pid"),out pid)) return false;
        string exe=Value(state,"executable"); if(String.IsNullOrEmpty(exe)||!File.Exists(exe))return false;
        try {
            var process=Process.GetProcessById(pid);
            if(process.HasExited || !String.Equals(process.MainModule.FileName,exe,StringComparison.OrdinalIgnoreCase))return false;
            StartDesktop(exe); return true;
        } catch(ArgumentException) {return false;} catch(System.ComponentModel.Win32Exception) {return false;}
    }
    static Process StartDesktop(string exe) {
        var info=new ProcessStartInfo(exe) { UseShellExecute=false, WorkingDirectory=Path.GetDirectoryName(exe) };
        info.EnvironmentVariables["DSH_HOME"]=DataHome;
        info.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        info.EnvironmentVariables.Remove("NODE_OPTIONS");
        return Process.Start(info);
    }
    static void Prepare(string package) {
        var info=new ProcessStartInfo(Path.Combine(package,"app","DeepSeek Harness.exe"),"--expose-internals "+Quote(Path.Combine(package,"prepare.cjs"))+" "+Quote(DataHome)) {
            UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,
            WorkingDirectory=package,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8
        };
        info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"]="1"; info.EnvironmentVariables["DSH_HOME"]=DataHome;
        info.EnvironmentVariables.Remove("NODE_OPTIONS");
        using(var process=Process.Start(info)) {
            var errors=process.StandardError.ReadToEndAsync();
            string line;
            while((line=process.StandardOutput.ReadLine())!=null) if(line.Length>0) Status(line,95);
            process.WaitForExit();
            if(process.ExitCode!=0) throw new Exception("本地组件初始化失败。\n"+errors.Result);
        }
    }
    static string Extract(string self,Payload payload) {
        string packages=Path.Combine(InstallRoot,"packages"); Directory.CreateDirectory(packages);
        string target=Path.Combine(packages,"0.5.0-"+payload.Hash.Substring(0,12));
        string complete=Path.Combine(target,".chengmeng-complete");
        if(File.Exists(complete) && File.ReadAllText(complete)==payload.Hash && File.Exists(Path.Combine(target,"prepare.cjs")) && File.Exists(Path.Combine(target,"app","DeepSeek Harness.exe")) && File.Exists(Path.Combine(target,"embedding","model","model.safetensors"))) return target;
        Status("正在校验完整安装包…",2);
        using(var stream=new SliceStream(self,payload.Offset,payload.Length)) using(var sha=SHA256.Create()) {
            string actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
            if(actual!=payload.Hash) throw new Exception("安装包校验失败，请重新取得完整 EXE。");
        }
        string staging=target+".partial-"+Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(staging);
        string boundary=Path.GetFullPath(staging)+Path.DirectorySeparatorChar;
        using(var stream=new SliceStream(self,payload.Offset,payload.Length)) using(var zip=new ZipArchive(stream,ZipArchiveMode.Read)) {
            long total=0,done=0; foreach(var entry in zip.Entries) total+=entry.Length;
            byte[] buffer=new byte[1024*1024]; var timer=Stopwatch.StartNew();
            foreach(var entry in zip.Entries) {
                string path=Path.GetFullPath(Path.Combine(staging,entry.FullName.Replace('/',Path.DirectorySeparatorChar)));
                if(!path.StartsWith(boundary,StringComparison.OrdinalIgnoreCase))throw new Exception("安装包包含无效路径。");
                if(entry.FullName.EndsWith("/")) {Directory.CreateDirectory(path);continue;}
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                using(var from=entry.Open()) using(var to=new FileStream(path,FileMode.CreateNew,FileAccess.Write)) {
                    int n; while((n=from.Read(buffer,0,buffer.Length))>0) {
                        to.Write(buffer,0,n);done+=n;
                        if(timer.ElapsedMilliseconds>600) {Status("正在解包桌面程序、插件和记忆模型… "+(done*100/Math.Max(total,1))+"%",5+(int)(done*84/Math.Max(total,1)));timer.Restart();}
                    }
                }
            }
        }
        File.WriteAllText(Path.Combine(staging,".chengmeng-complete"),payload.Hash);
        // Never delete an interrupted or damaged tree. Quarantine it in-place.
        if(Directory.Exists(target)) Directory.Move(target,target+".previous-"+DateTime.UtcNow.Ticks);
        Directory.Move(staging,target); return target;
    }
    static void InstallStub(string self,Payload payload) {
        string destination=Path.Combine(InstallRoot,"Chengmeng.exe");
        if(File.Exists(destination)) return;
        string temp=destination+".tmp";
        using(var from=new SliceStream(self,0,payload.Offset))using(var to=new FileStream(temp,FileMode.Create,FileAccess.Write))from.CopyTo(to);
        File.Move(temp,destination);
    }
    static void CreateShortcuts() {
        string exe=Path.Combine(InstallRoot,"Chengmeng.exe"); if(!File.Exists(exe))return;
        try {
            Type type=Type.GetTypeFromProgID("WScript.Shell"); object shell=Activator.CreateInstance(type);
            foreach(string folder in new[]{Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),Environment.GetFolderPath(Environment.SpecialFolder.Programs)}) {
                string file=Path.Combine(folder,"Chengmeng.lnk");
                object shortcut=type.InvokeMember("CreateShortcut",System.Reflection.BindingFlags.InvokeMethod,null,shell,new object[]{file});
                var t=shortcut.GetType();
                t.InvokeMember("TargetPath",System.Reflection.BindingFlags.SetProperty,null,shortcut,new object[]{exe});
                t.InvokeMember("WorkingDirectory",System.Reflection.BindingFlags.SetProperty,null,shortcut,new object[]{InstallRoot});
                t.InvokeMember("Description",System.Reflection.BindingFlags.SetProperty,null,shortcut,new object[]{"Chengmeng · 自动记忆与生活支持"});
                t.InvokeMember("Save",System.Reflection.BindingFlags.InvokeMethod,null,shortcut,null);
                System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut);
            }
            System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
        } catch(Exception e) {File.AppendAllText(LogFile,"Shortcut: "+e.Message+Environment.NewLine);}
    }
    sealed class ProgressWindow:Form {
        readonly Label message;readonly ProgressBar progress;
        public ProgressWindow() {
            Text="Chengmeng";ClientSize=new Size(520,190);FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;MinimizeBox=false;ControlBox=false;StartPosition=FormStartPosition.CenterScreen;
            BackColor=Color.FromArgb(249,244,248);Font=new Font("Microsoft YaHei UI",10);
            try {Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);}catch{}
            Controls.Add(new Label {Text="Chengmeng",Font=new Font("Segoe UI",22,FontStyle.Bold),ForeColor=Color.FromArgb(76,67,102),Location=new Point(28,20),AutoSize=true});
            message=new Label{Text="正在准备…",Location=new Point(30,80),Size=new Size(460,42)};Controls.Add(message);
            progress=new ProgressBar{Location=new Point(30,137),Size=new Size(460,12),Minimum=0,Maximum=100};Controls.Add(progress);
        }
        public void SetProgress(string text,int value){message.Text=text;progress.Value=Math.Max(0,Math.Min(100,value));}
    }
    sealed class Payload {
        public long Offset,Length; public string Hash;
        public static Payload TryRead(string file) {
            using(var stream=File.OpenRead(file)) {
                if(stream.Length<56)return null;stream.Seek(-56,SeekOrigin.End);
                using(var reader=new BinaryReader(stream)) {
                    if(Encoding.ASCII.GetString(reader.ReadBytes(8))!="CHGMEXE1")return null;
                    long offset=reader.ReadInt64(),length=reader.ReadInt64();
                    if(offset<4096||length<22||offset>stream.Length-56||length!=stream.Length-56-offset)throw new Exception("安装包尾部损坏。");
                    return new Payload{Offset=offset,Length=length,Hash=BitConverter.ToString(reader.ReadBytes(32)).Replace("-","").ToLowerInvariant()};
                }
            }
        }
    }
    sealed class SliceStream:Stream {
        readonly FileStream source;readonly long offset,length;long position;
        public SliceStream(string file,long start,long count){source=File.OpenRead(file);offset=start;length=count;source.Position=start;}
        public override bool CanRead{get{return true;}}public override bool CanSeek{get{return true;}}public override bool CanWrite{get{return false;}}
        public override long Length{get{return length;}}public override long Position{get{return position;}set{Seek(value,SeekOrigin.Begin);}}
        public override int Read(byte[] buffer,int start,int count){int n=source.Read(buffer,start,(int)Math.Min(count,length-position));position+=n;return n;}
        public override long Seek(long value,SeekOrigin origin){long next=origin==SeekOrigin.Begin?value:origin==SeekOrigin.Current?position+value:length+value;if(next<0||next>length)throw new IOException("Invalid archive position");source.Position=offset+next;position=next;return next;}
        public override void Flush(){}public override void SetLength(long value){throw new NotSupportedException();}public override void Write(byte[] b,int o,int c){throw new NotSupportedException();}
        protected override void Dispose(bool disposing){if(disposing)source.Dispose();base.Dispose(disposing);}
    }
}
