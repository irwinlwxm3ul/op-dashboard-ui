// Stylesheet for the game-feel overlays, injected once into <head>. Everything is
// pointer-events: none and lives inside the UI's feel layer (above the 3D canvas, below the HUD).
//
// Re-triggered pop animations alternate between two identical keyframe sets (`*-a` / `*-b`):
// switching animation-name restarts a CSS animation without forcing a synchronous reflow.

const STYLE_ID = 'dz-feel-style';

const CSS = /* css */ `
.dzf-root{position:absolute;inset:0;pointer-events:none;overflow:hidden;user-select:none;-webkit-user-select:none;contain:strict;
  font-family:system-ui,"Noto Sans","Noto Sans CJK SC","Noto Sans Arabic","Segoe UI",sans-serif;}
.dzf-root *{pointer-events:none;box-sizing:border-box;}
.dzf-full{position:absolute;inset:0;opacity:0;}

/* ---- Vitals: low health, desaturation, downed ---- */
.dzf-lowhp{background:radial-gradient(ellipse at 50% 50%,rgba(130,0,0,0) 36%,rgba(150,0,0,.30) 66%,rgba(115,0,0,.82) 100%);will-change:opacity;}
.dzf-desat{display:none;}
.dzf-downed{display:none;opacity:1;background:radial-gradient(ellipse at 50% 50%,rgba(30,30,36,.18) 25%,rgba(14,14,18,.62) 100%);
  backdrop-filter:grayscale(.88) brightness(.82);-webkit-backdrop-filter:grayscale(.88) brightness(.82);}

/* ---- Damage taken: screen-edge flash and direction arcs ---- */
.dzf-flash{background:radial-gradient(ellipse at 50% 50%,rgba(255,0,0,0) 48%,rgba(220,12,0,.40) 80%,rgba(190,0,0,.78) 100%);will-change:opacity;}
.dzf-dir{position:absolute;left:50%;top:50%;width:30vmin;height:30vmin;margin:-15vmin 0 0 -15vmin;border-radius:50%;
  border:1.1vmin solid transparent;border-top-color:rgba(255,38,26,.95);opacity:0;display:none;will-change:transform,opacity;
  filter:drop-shadow(0 0 .7vmin rgba(255,0,0,.6));
  -webkit-mask-image:conic-gradient(from -42deg,transparent 0deg,#000 16deg,#000 68deg,transparent 84deg);
  mask-image:conic-gradient(from -42deg,transparent 0deg,#000 16deg,#000 68deg,transparent 84deg);}

/* ---- Hitmarker ---- */
.dzf-hm{position:absolute;left:50%;top:50%;width:0;height:0;opacity:0;--c:#fff;--l:9px;--g:7px;--w:2px;--d:.3s;}
.dzf-hm i{position:absolute;left:calc(var(--w) / -2);top:calc(-1 * (var(--g) + var(--l)));width:var(--w);height:var(--l);
  background:var(--c);border-radius:1px;box-shadow:0 0 2px rgba(0,0,0,.85);transform-origin:50% calc(var(--g) + var(--l));}
.dzf-hm i:nth-child(1){transform:rotate(45deg);}
.dzf-hm i:nth-child(2){transform:rotate(135deg);}
.dzf-hm i:nth-child(3){transform:rotate(225deg);}
.dzf-hm i:nth-child(4){transform:rotate(315deg);}
.dzf-hm-body{--c:#fff;}
.dzf-hm-armor{--c:#8fd0ff;--d:.32s;}
.dzf-hm-head{--c:#ff3b30;--l:11px;--w:2.5px;--d:.4s;}
.dzf-hm-knock{--c:#ff9f1c;--l:13px;--g:9px;--w:3px;--d:.55s;}
.dzf-hm-kill{--c:#ff2d2d;--l:15px;--g:11px;--w:3px;--d:.75s;}
.dzf-hm-skull{position:absolute;left:-9px;top:-9px;width:18px;height:18px;color:#ff2d2d;display:none;
  filter:drop-shadow(0 0 2px rgba(0,0,0,.9));}
.dzf-hm-kill .dzf-hm-skull{display:block;}
.dzf-hm-shard{position:absolute;left:16px;top:-30px;width:16px;height:16px;color:#8fd0ff;display:none;filter:drop-shadow(0 0 2px rgba(0,0,0,.9));}
.dzf-hm-shatter .dzf-hm-shard{display:block;}
.dzf-hm.dzf-pa{animation:dzf-hm-a var(--d) ease-out forwards;}
.dzf-hm.dzf-pb{animation:dzf-hm-b var(--d) ease-out forwards;}
@keyframes dzf-hm-a{0%{opacity:1;transform:scale(1.5);}14%{opacity:1;transform:scale(1);}55%{opacity:1;}100%{opacity:0;transform:scale(1);}}
@keyframes dzf-hm-b{0%{opacity:1;transform:scale(1.5);}14%{opacity:1;transform:scale(1);}55%{opacity:1;}100%{opacity:0;transform:scale(1);}}

/* ---- Damage numbers ---- */
.dzf-num{position:absolute;left:0;top:0;display:none;white-space:nowrap;will-change:transform,opacity;
  font-weight:800;font-size:17px;line-height:1;color:#fff;letter-spacing:.01em;
  text-shadow:0 0 3px rgba(0,0,0,.95),0 1px 1px rgba(0,0,0,.95);}
.dzf-num>span{display:inline-block;transform:translate(-50%,-50%);}
.dzf-num.dzf-head{color:#ff4a3d;font-size:20px;}
.dzf-num.dzf-limb{color:#cfd3d8;font-size:15px;}
.dzf-num.dzf-armor{color:#9fd2ff;}
.dzf-num.dzf-lethal{font-size:23px;}
.dzf-num.dzf-pa>span{animation:dzf-num-a .24s cubic-bezier(.2,1.5,.4,1);}
.dzf-num.dzf-pb>span{animation:dzf-num-b .24s cubic-bezier(.2,1.5,.4,1);}
@keyframes dzf-num-a{from{transform:translate(-50%,-50%) scale(1.8);}to{transform:translate(-50%,-50%) scale(1);}}
@keyframes dzf-num-b{from{transform:translate(-50%,-50%) scale(1.8);}to{transform:translate(-50%,-50%) scale(1);}}

/* ---- Training readout (center right) ---- */
.dzf-ro{position:absolute;left:calc(50% + 46px);top:calc(50% - 9px);display:none;white-space:nowrap;will-change:transform,opacity;
  font-size:13px;font-weight:700;color:#e9ecef;text-shadow:0 0 3px rgba(0,0,0,.95),0 1px 1px rgba(0,0,0,.9);direction:ltr;}
.dzf-ro b{font-size:17px;font-weight:800;color:#fff;margin-right:7px;}
.dzf-ro .dzf-ro-part{margin-right:7px;color:#fff;}
.dzf-ro.dzf-head .dzf-ro-part,.dzf-ro.dzf-head b{color:#ff4a3d;}
.dzf-ro.dzf-limb .dzf-ro-part{color:#cfd3d8;}
.dzf-ro .dzf-ro-dist{color:#f2c94c;}

/* ---- Armor break (victim) ---- */
.dzf-ab{position:absolute;left:50%;bottom:17%;display:none;flex-direction:column;align-items:center;gap:2px;transform:translateX(-50%);opacity:0;
  width:max-content;max-width:96vw;}
.dzf-ab svg{width:34px;height:34px;color:#8fd0ff;overflow:visible;filter:drop-shadow(0 0 5px rgba(120,190,255,.7));}
.dzf-ab span{font-size:13px;font-weight:800;color:#cfe8ff;text-transform:uppercase;letter-spacing:.06em;text-shadow:0 1px 3px rgba(0,0,0,.9);}
.dzf-ab.dzf-pa,.dzf-ab.dzf-pb{display:flex;}
.dzf-ab.dzf-pa{animation:dzf-ab-a 1.4s ease-out forwards;}
.dzf-ab.dzf-pb{animation:dzf-ab-b 1.4s ease-out forwards;}
@keyframes dzf-ab-a{0%{opacity:0;transform:translateX(-50%) scale(1.6);}10%{opacity:1;transform:translateX(-50%) scale(1);}70%{opacity:1;}100%{opacity:0;}}
@keyframes dzf-ab-b{0%{opacity:0;transform:translateX(-50%) scale(1.6);}10%{opacity:1;transform:translateX(-50%) scale(1);}70%{opacity:1;}100%{opacity:0;}}
.dzf-shard-l,.dzf-shard-r{transform-box:fill-box;transform-origin:50% 50%;}
.dzf-pa .dzf-shard-l{animation:dzf-shl-a .9s cubic-bezier(.2,.8,.3,1) forwards;}
.dzf-pb .dzf-shard-l{animation:dzf-shl-b .9s cubic-bezier(.2,.8,.3,1) forwards;}
.dzf-pa .dzf-shard-r{animation:dzf-shr-a .9s cubic-bezier(.2,.8,.3,1) forwards;}
.dzf-pb .dzf-shard-r{animation:dzf-shr-b .9s cubic-bezier(.2,.8,.3,1) forwards;}
.dzf-hm-shatter.dzf-pa .dzf-shard-l{animation:dzf-shl-a .5s cubic-bezier(.2,.8,.3,1) forwards;}
.dzf-hm-shatter.dzf-pb .dzf-shard-l{animation:dzf-shl-b .5s cubic-bezier(.2,.8,.3,1) forwards;}
.dzf-hm-shatter.dzf-pa .dzf-shard-r{animation:dzf-shr-a .5s cubic-bezier(.2,.8,.3,1) forwards;}
.dzf-hm-shatter.dzf-pb .dzf-shard-r{animation:dzf-shr-b .5s cubic-bezier(.2,.8,.3,1) forwards;}
@keyframes dzf-shl-a{0%,15%{transform:none;}100%{transform:translate(-4px,3px) rotate(-14deg);}}
@keyframes dzf-shl-b{0%,15%{transform:none;}100%{transform:translate(-4px,3px) rotate(-14deg);}}
@keyframes dzf-shr-a{0%,15%{transform:none;}100%{transform:translate(4px,3px) rotate(14deg);}}
@keyframes dzf-shr-b{0%,15%{transform:none;}100%{transform:translate(4px,3px) rotate(14deg);}}

/* ---- Kill / death banner (center bottom) ---- */
.dzf-kb{position:absolute;left:50%;bottom:24%;display:none;flex-direction:column;align-items:center;gap:3px;text-align:center;
  transform:translateX(-50%);opacity:0;width:max-content;max-width:92vw;}
.dzf-kb.dzf-pa,.dzf-kb.dzf-pb{display:flex;}
.dzf-kb-icon{width:38px;height:38px;color:#ff3b30;filter:drop-shadow(0 0 7px rgba(255,40,30,.65));}
.dzf-kb-icon svg{width:100%;height:100%;}
.dzf-kb-main{font-size:22px;font-weight:800;color:#fff;letter-spacing:.02em;text-shadow:0 2px 5px rgba(0,0,0,.9);}
.dzf-kb-sub{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:700;color:#f2c94c;text-shadow:0 1px 3px rgba(0,0,0,.9);}
.dzf-kb-sub:empty{display:none;}
.dzf-kb-tag{background:#ff3b30;color:#fff;padding:1px 7px;border-radius:3px;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;text-shadow:none;}
.dzf-kb-knock .dzf-kb-icon{color:#ff9f1c;filter:drop-shadow(0 0 7px rgba(255,159,28,.6));}
.dzf-kb-death .dzf-kb-main{color:#ff6b61;}
.dzf-kb-death .dzf-kb-icon{color:#d8d8d8;filter:drop-shadow(0 0 6px rgba(0,0,0,.7));}
.dzf-kb-death .dzf-kb-sub{color:#e0e0e0;}
.dzf-kb.dzf-pa{animation:dzf-kb-a 3.2s cubic-bezier(.2,.9,.3,1.1) forwards;}
.dzf-kb.dzf-pb{animation:dzf-kb-b 3.2s cubic-bezier(.2,.9,.3,1.1) forwards;}
@keyframes dzf-kb-a{0%{opacity:0;transform:translateX(-50%) scale(1.3);}7%{opacity:1;transform:translateX(-50%) scale(1);}86%{opacity:1;transform:translateX(-50%);}100%{opacity:0;transform:translateX(-50%) translateY(-10px);}}
@keyframes dzf-kb-b{0%{opacity:0;transform:translateX(-50%) scale(1.3);}7%{opacity:1;transform:translateX(-50%) scale(1);}86%{opacity:1;transform:translateX(-50%);}100%{opacity:0;transform:translateX(-50%) translateY(-10px);}}
.dzf-kb.dzf-pa .dzf-kb-icon{animation:dzf-skull-a .5s cubic-bezier(.2,1.7,.4,1);}
.dzf-kb.dzf-pb .dzf-kb-icon{animation:dzf-skull-b .5s cubic-bezier(.2,1.7,.4,1);}
@keyframes dzf-skull-a{0%{transform:scale(0) rotate(-30deg);}100%{transform:scale(1) rotate(0);}}
@keyframes dzf-skull-b{0%{transform:scale(0) rotate(-30deg);}100%{transform:scale(1) rotate(0);}}

/* ---- Match moment banner (top center) ---- */
.dzf-mb{position:absolute;left:50%;top:14%;display:none;flex-direction:column;align-items:center;gap:2px;text-align:center;
  transform:translateX(-50%);opacity:0;padding:9px 56px;width:max-content;max-width:96vw;
  background:linear-gradient(90deg,rgba(0,0,0,0),rgba(0,0,0,.58) 22%,rgba(0,0,0,.58) 78%,rgba(0,0,0,0));}
.dzf-mb.dzf-pa,.dzf-mb.dzf-pb{display:flex;}
.dzf-mb-title{font-size:22px;font-weight:800;color:#fff;letter-spacing:.02em;text-shadow:0 2px 4px rgba(0,0,0,.8);}
.dzf-mb-sub{font-size:14px;font-weight:600;color:#d9dde2;}
.dzf-mb-sub:empty{display:none;}
.dzf-mb-zone .dzf-mb-title{color:#8cc4ff;}
.dzf-mb-zone{border-top:2px solid;border-image:linear-gradient(90deg,rgba(80,150,255,0),rgba(80,150,255,.9) 25%,rgba(80,150,255,.9) 75%,rgba(80,150,255,0)) 1;}
.dzf-mb-lose .dzf-mb-title{font-size:34px;color:#ff5a4f;}
.dzf-mb-win{top:12%;background:radial-gradient(closest-side,rgba(60,40,0,.62),rgba(30,20,0,.4) 60%,rgba(0,0,0,0));padding:30px 110px;}
.dzf-mb-win .dzf-mb-title{font-size:46px;line-height:1.05;color:#ffd23f;letter-spacing:.03em;
  text-shadow:0 0 18px rgba(255,190,0,.75),0 3px 0 #8a5a00,0 6px 12px rgba(0,0,0,.8);}
.dzf-mb-win .dzf-mb-sub{font-size:18px;color:#fff3c4;}
.dzf-mb.dzf-pa{animation:dzf-mb-a var(--d,3.4s) cubic-bezier(.2,.9,.3,1) forwards;}
.dzf-mb.dzf-pb{animation:dzf-mb-b var(--d,3.4s) cubic-bezier(.2,.9,.3,1) forwards;}
@keyframes dzf-mb-a{0%{opacity:0;transform:translateX(-50%) translateY(-12px);}8%{opacity:1;transform:translateX(-50%);}88%{opacity:1;}100%{opacity:0;}}
@keyframes dzf-mb-b{0%{opacity:0;transform:translateX(-50%) translateY(-12px);}8%{opacity:1;transform:translateX(-50%);}88%{opacity:1;}100%{opacity:0;}}
.dzf-mb-win.dzf-pa .dzf-mb-title{animation:dzf-win-a 1.6s cubic-bezier(.2,1.6,.4,1), dzf-glow 1.2s ease-in-out 1.6s infinite alternate;}
.dzf-mb-win.dzf-pb .dzf-mb-title{animation:dzf-win-b 1.6s cubic-bezier(.2,1.6,.4,1), dzf-glow 1.2s ease-in-out 1.6s infinite alternate;}
@keyframes dzf-win-a{0%{transform:scale(.3);opacity:0;}35%{transform:scale(1.08);opacity:1;}100%{transform:scale(1);}}
@keyframes dzf-win-b{0%{transform:scale(.3);opacity:0;}35%{transform:scale(1.08);opacity:1;}100%{transform:scale(1);}}
@keyframes dzf-glow{from{text-shadow:0 0 14px rgba(255,190,0,.6),0 3px 0 #8a5a00,0 6px 12px rgba(0,0,0,.8);}
  to{text-shadow:0 0 30px rgba(255,210,60,1),0 3px 0 #8a5a00,0 6px 12px rgba(0,0,0,.8);}}

/* ---- Notices (teammates, revives) ---- */
.dzf-notes{position:absolute;left:50%;top:26%;display:flex;flex-direction:column;align-items:center;gap:4px;transform:translateX(-50%);
  width:max-content;max-width:92vw;}
.dzf-note{display:none;font-size:15px;font-weight:700;color:#fff;padding:3px 12px;border-radius:3px;white-space:nowrap;
  background:rgba(0,0,0,.5);border-inline-start:3px solid #3ad0ff;text-shadow:0 1px 2px rgba(0,0,0,.8);opacity:0;}
.dzf-note.dzf-bad{border-inline-start-color:#ff3b30;color:#ffd9d6;}
.dzf-note.dzf-good{border-inline-start-color:#53d769;color:#dcffe2;}
.dzf-note.dzf-pa,.dzf-note.dzf-pb{display:block;}
.dzf-note.dzf-pa{animation:dzf-note-a 3.6s ease forwards;}
.dzf-note.dzf-pb{animation:dzf-note-b 3.6s ease forwards;}
@keyframes dzf-note-a{0%{opacity:0;transform:translateY(-6px);}8%{opacity:1;transform:none;}85%{opacity:1;}100%{opacity:0;}}
@keyframes dzf-note-b{0%{opacity:0;transform:translateY(-6px);}8%{opacity:1;transform:none;}85%{opacity:1;}100%{opacity:0;}}

@media (max-height:640px){
  .dzf-kb-main,.dzf-mb-title{font-size:18px;}
  .dzf-mb-win .dzf-mb-title{font-size:32px;}
}
`;

/** Injects the overlay stylesheet once per document. */
export function ensureFeelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}
