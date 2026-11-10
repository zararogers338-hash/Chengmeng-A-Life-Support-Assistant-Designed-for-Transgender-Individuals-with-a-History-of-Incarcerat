/**
 * 客户端样式：一张 <style data-chengmeng-memory> 标签里的全部 CSS。
 *
 * 风格遵循 docs/DESIGN.md：浅色 Pastel + 液态玻璃、弹簧动效、尊重「减少动态效果」。
 * - 颜色优先用 DSH 的 --dsw-* 语义 token，取不到就退回中性浅色，所以不开 Pastel 也能正常阅读；
 * - 只做浅色，不做深色（项目所有者 2026-11-10 决定）；
 * - 透明度/颜色/模糊只用 fade 弹簧，位移用 sheet/travel，按下只允许轻微缩放（chrome 可以有一点弹性）；
 * - 打开「减少动态效果」后无位移、无回弹、无循环动画。
 *
 * 类名一律 cm- 前缀；本文件不依赖 React，构建脚本会把它内联进 lib/client.js。
 */

/**
 * @param {string} springVariables springCSSVariables() 的输出（--cm-spring-* 与时长）
 * @returns {string} 完整 CSS
 */
export function memoryCSS(springVariables) {
  return `
/* 弹簧 token 只挂在本模块自己的根节点上，不污染全局 */
.cm-mem-dock,
.cm-mem-settings{${springVariables}}

/* ── 输入框下方的待确认玻璃卡片 ───────────────────────────────── */
.cm-mem-dock{
  position:relative;
  display:grid;
  gap:10px;
  box-sizing:border-box;
  /* 宿主 dock 是居中的 flex 行（旁边还有上下文占用 pill），所以给出最小/最大宽度，
     让卡片稳定地呈一张居中玻璃卡，而不是被内容宽度挤压。 */
  width:100%;
  min-width:min(420px, calc(100vw - 48px));
  max-width:min(560px, calc(100vw - 48px));
  min-height:0;
  flex:none;
  margin:8px 0 0;
  padding:14px 16px;
  border-radius:var(--dsw-radius-panel, 22px);
  color:var(--dsw-alias-label-primary, #1E2433);
  background:rgb(250 246 245 / .86);
  background:color-mix(in srgb, var(--dsw-specific-menu, #FAF6F5) 84%, transparent);
  -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter, blur(18px) saturate(1.35));
  backdrop-filter:var(--dsw-menu-backdrop-filter, blur(18px) saturate(1.35));
  box-shadow:
    var(--dsw-elevation-panel, 0 18px 42px -24px rgb(40 46 70 / .32)),
    inset 0 1px 0 rgb(255 255 255 / .82),
    inset 0 0 0 1px var(--dsw-alias-border-l1, rgb(120 126 150 / .18));
  animation:cm-mem-dock-in var(--cm-spring-sheet-ms, 420ms) var(--cm-spring-sheet, ease-out) both;
}
@keyframes cm-mem-dock-in{
  from{opacity:0;transform:translateY(6px)}
  to{opacity:1;transform:none}
}
.cm-mem-dock-head{
  display:flex;
  align-items:baseline;
  justify-content:space-between;
  gap:8px;
}
.cm-mem-dock-title{
  margin:0;
  font-size:13px;
  font-weight:600;
  letter-spacing:.01em;
  color:var(--dsw-alias-label-primary, #1E2433);
}
.cm-mem-dock-text{
  margin:0;
  max-height:132px;
  overflow-y:auto;
  white-space:pre-wrap;
  overflow-wrap:anywhere;
  font-size:14px;
  line-height:1.65;
  color:var(--dsw-alias-label-primary, #1E2433);
  scrollbar-width:thin;
}
.cm-mem-dock-meta{
  display:flex;
  flex-wrap:wrap;
  gap:4px 10px;
  align-items:baseline;
}
.cm-mem-dock-note{
  font-size:12px;
  color:var(--dsw-alias-label-secondary, #5B6178);
}
.cm-mem-dock-error{
  margin:0;
  font-size:12px;
  color:var(--dsw-alias-label-secondary, #5B6178);
}
.cm-mem-dock-actions{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  justify-content:flex-end;
}

/* ── 按钮（原生 button，键盘可达；按下只做轻微缩放） ───────────── */
.cm-mem-btn{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  height:30px;
  padding:0 14px;
  border:1px solid var(--dsw-alias-border-l1, rgb(120 126 150 / .28));
  border-radius:999px;
  background:rgb(255 255 255 / .58);
  color:var(--dsw-alias-label-primary, #1E2433);
  font:inherit;
  font-size:13px;
  line-height:1;
  white-space:nowrap;
  cursor:pointer;
  transition:
    background-color var(--cm-spring-fade-ms, 200ms) var(--cm-spring-fade, ease),
    border-color var(--cm-spring-fade-ms, 200ms) var(--cm-spring-fade, ease),
    opacity var(--cm-spring-fade-ms, 200ms) var(--cm-spring-fade, ease),
    transform var(--cm-spring-press-ms, 360ms) var(--cm-spring-press, ease);
}
.cm-mem-btn:hover{background:rgb(255 255 255 / .8)}
.cm-mem-btn:active{transform:scale(.97)}
.cm-mem-btn:focus-visible{
  outline:2px solid var(--dsw-focus-ring-color, #4176E6);
  outline-offset:2px;
}
.cm-mem-btn:disabled{opacity:.5;cursor:default;transform:none}
.cm-mem-btn-primary{
  border-color:transparent;
  background:rgb(248 138 162 / .3);
}
.cm-mem-btn-primary:hover{background:rgb(248 138 162 / .42)}
.cm-mem-btn-quiet{
  border-color:transparent;
  background:transparent;
  color:var(--dsw-alias-label-secondary, #5B6178);
}
.cm-mem-btn-quiet:hover{background:rgb(128 134 150 / .12)}
.cm-mem-btn-danger{color:#8C3B52}
.cm-mem-btn-danger:hover{background:rgb(248 138 162 / .18)}
.cm-mem-btn-sm{height:26px;padding:0 11px;font-size:12px}

/* ── 输入控件 ─────────────────────────────────────────────────── */
.cm-mem-input,
.cm-mem-textarea,
.cm-mem-select{
  box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l1, rgb(120 126 150 / .26));
  border-radius:12px;
  background:rgb(255 255 255 / .72);
  color:var(--dsw-alias-label-primary, #1E2433);
  font:inherit;
  font-size:13px;
  line-height:1.6;
  padding:7px 10px;
}
.cm-mem-input::placeholder,
.cm-mem-textarea::placeholder{color:var(--dsw-alias-label-tertiary, #8A90A4)}
.cm-mem-input:focus-visible,
.cm-mem-textarea:focus-visible,
.cm-mem-select:focus-visible{
  outline:2px solid var(--dsw-focus-ring-color, #4176E6);
  outline-offset:1px;
}
.cm-mem-textarea{width:100%;min-height:64px;max-height:180px;resize:vertical}
.cm-mem-select{height:30px;padding:0 8px;cursor:pointer}

/* ── 设置页「记忆」一节 ───────────────────────────────────────── */
.cm-mem-settings{
  display:grid;
  gap:22px;
  max-width:760px;
  font-size:13px;
  line-height:1.6;
  color:var(--dsw-alias-label-primary, #1E2433);
}
.cm-mem-settings-title{
  margin:0;
  font-size:15px;
  font-weight:600;
  color:var(--dsw-alias-label-primary, #1E2433);
}
.cm-mem-settings-hint{
  margin:0;
  font-size:12px;
  line-height:1.7;
  color:var(--dsw-alias-label-secondary, #5B6178);
}
.cm-mem-settings-group{display:grid;gap:8px}
.cm-mem-settings-row{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:8px;
}
.cm-mem-switch-row{
  display:flex;
  align-items:flex-start;
  gap:10px;
}
.cm-mem-check{
  width:16px;
  height:16px;
  margin:3px 0 0;
  accent-color:#F88AA2;
  cursor:pointer;
}
.cm-mem-check:focus-visible{
  outline:2px solid var(--dsw-focus-ring-color, #4176E6);
  outline-offset:2px;
}
.cm-mem-check:disabled{cursor:default;opacity:.5}
.cm-mem-choice{
  height:28px;
  padding:0 12px;
  border:1px solid var(--dsw-alias-border-l1, rgb(120 126 150 / .26));
  border-radius:999px;
  background:transparent;
  color:var(--dsw-alias-label-secondary, #5B6178);
  font:inherit;
  font-size:12px;
  cursor:pointer;
  transition:background-color var(--cm-spring-fade-ms, 200ms) var(--cm-spring-fade, ease);
}
.cm-mem-choice[aria-pressed=true]{
  background:rgb(253 221 227 / .92);
  border-color:rgb(248 138 162 / .5);
  color:var(--dsw-alias-label-primary, #1E2433);
}
.cm-mem-choice:focus-visible{
  outline:2px solid var(--dsw-focus-ring-color, #4176E6);
  outline-offset:2px;
}
.cm-mem-choice:disabled{cursor:default;opacity:.5}

.cm-mem-toolbar{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:8px;
}
.cm-mem-search{flex:1 1 220px;min-width:160px}
.cm-mem-list{
  list-style:none;
  margin:0;
  padding:0;
  display:grid;
}
.cm-mem-row{
  padding:13px 0;
  border-top:1px solid var(--dsw-alias-border-l1, rgb(120 126 150 / .14));
}
.cm-mem-row:first-child{border-top:0}
.cm-mem-mem-text{
  margin:0;
  white-space:pre-wrap;
  overflow-wrap:anywhere;
  font-size:13px;
  line-height:1.65;
  color:var(--dsw-alias-label-primary, #1E2433);
}
.cm-mem-row-meta{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:4px 10px;
  margin-top:7px;
  font-size:12px;
  color:var(--dsw-alias-label-tertiary, #767C92);
}
.cm-mem-tag{
  display:inline-flex;
  align-items:center;
  height:18px;
  padding:0 7px;
  border-radius:999px;
  background:rgb(128 134 150 / .14);
  font-size:11px;
  line-height:1;
  color:var(--dsw-alias-label-secondary, #5B6178);
}
.cm-mem-tag-ok{background:rgb(28 203 252 / .16)}
.cm-mem-source{
  max-width:240px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.cm-mem-link{
  border:0;
  padding:0;
  border-radius:4px;
  background:transparent;
  color:var(--dsw-alias-label-secondary, #4A5068);
  font:inherit;
  font-size:12px;
  text-decoration:underline;
  text-underline-offset:2px;
  cursor:pointer;
}
.cm-mem-link:focus-visible{
  outline:2px solid var(--dsw-focus-ring-color, #4176E6);
  outline-offset:2px;
}
.cm-mem-row-actions{
  display:flex;
  flex-wrap:wrap;
  gap:6px;
  margin-top:8px;
}
.cm-mem-detail{
  display:grid;
  gap:5px;
  margin:9px 0 0;
  padding:9px 11px;
  border-radius:12px;
  background:rgb(128 134 150 / .08);
  font-size:12px;
  line-height:1.6;
  color:var(--dsw-alias-label-secondary, #5B6178);
}
.cm-mem-detail-title{
  margin:0;
  font-size:12px;
  font-weight:600;
  color:var(--dsw-alias-label-secondary, #4A5068);
}
.cm-mem-reasons{
  display:flex;
  flex-wrap:wrap;
  gap:4px;
  margin:0;
  padding:0;
  list-style:none;
}
.cm-mem-empty{
  margin:0;
  padding:14px 0;
  font-size:12px;
  color:var(--dsw-alias-label-tertiary, #767C92);
}
.cm-mem-error,
.cm-mem-notice{
  margin:0;
  font-size:12px;
  line-height:1.6;
  color:var(--dsw-alias-label-secondary, #5B6178);
}
.cm-mem-settings-footer{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:8px;
}
.cm-mem-danger{
  display:grid;
  gap:8px;
  padding-top:14px;
  border-top:1px solid var(--dsw-alias-border-l1, rgb(120 126 150 / .16));
}
.cm-mem-settings [hidden]{display:none !important}

/* ── 减少动态效果：无位移、无回弹、无循环动画 ─────────────────── */
@media (prefers-reduced-motion: reduce){
  .cm-mem-dock{animation:none}
  .cm-mem-btn:active{transform:none}
  .cm-mem-btn,
  .cm-mem-choice{transition:background-color var(--cm-spring-fade-ms, 200ms) linear}
}
`
}
