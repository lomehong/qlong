import { useEffect, useState } from 'react';

/**
 * 真实可见宽度探测 + 流式布局驱动(穿透 iframe 裁剪)。
 *
 * 背景:控制台可能被嵌入固定宽度的 iframe(如 ModelScope 创空间包装页
 * min-width 1280)。此时 window.innerWidth 恒等于 iframe 宽度(1276),
 * CSS 媒体查询永远看不到浏览器窗口的真实大小,内容被直接裁掉。
 *
 * 原理:IntersectionObserver 的交集计算会沿 frame 树一路裁剪到顶层视口
 * (广告可见性测量的标准技术)。按 20px 间隔布置隐形探针,
 * 可见探针数 × 20 ≈ 屏幕上真实可见的宽度——与外层横滚位置无关
 * (横滚只平移可见探针的位置,不改变其数量)。
 *
 * 输出两层适配:
 *   1. <html style="--app-vw: Npx"> —— 被裁剪时把布局宽度钉成真实可见宽度,
 *      布局随窗口连续变化(流式);未裁剪(独立窗口/全宽)时移除该变量,自然 100%。
 *   2. <html data-vw="s|m|l"> —— 离散行为用档位:s <640 / m 640–860 / l ≥860
 *      (如侧边栏收成图标轨、dl 堆叠)。
 */

/** 探针间隔(px):20 粒度下窗口缩放时布局跟随近乎连续 */
const STEP = 20;
/** 探测范围:20 .. 3840(覆盖超宽外层包装) */
const STOPS: number[] = [];
for (let x = STEP; x <= 3840; x += STEP) STOPS.push(x);

type Tier = 's' | 'm' | 'l';

function tierOf(visibleWidth: number): Tier {
  if (visibleWidth < 640) return 's';
  if (visibleWidth < 860) return 'm';
  return 'l';
}

export function useVisibleWidthTier(): Tier {
  const [tier, setTier] = useState<Tier>(() => tierOf(window.innerWidth));

  useEffect(() => {
    // 先用 innerWidth 预填(独立窗口场景即正确;嵌入场景首轮 IO 回调会纠正),
    // 避免桌面端首帧闪窄版布局
    const visible = new Set<number>(STOPS.filter((x) => x <= window.innerWidth));
    const root = document.documentElement;
    const apply = (): void => {
      const estimated = visible.size * STEP;
      const cropped = estimated < window.innerWidth - STEP;
      // 仅在确实被裁剪时钉宽度;否则移除变量,布局自然占满
      if (cropped) root.style.setProperty('--app-vw', `${estimated}px`);
      else root.style.removeProperty('--app-vw');
      const t = tierOf(cropped ? estimated : window.innerWidth);
      root.dataset.vw = t;
      setTier(t);
    };

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const x = Number((e.target as HTMLElement).dataset.x ?? 0);
        if (e.isIntersecting) visible.add(x);
        else visible.delete(x);
      }
      apply();
    });

    const probes: HTMLDivElement[] = [];
    for (const x of STOPS) {
      const d = document.createElement('div');
      d.dataset.x = String(x);
      d.setAttribute('aria-hidden', 'true');
      // opacity 0 不影响 IO 的几何判定;fixed 相对 iframe 视口定位,不随 app 宽度变化
      d.style.cssText = `position:fixed;left:${x - 1}px;top:0;width:1px;height:1px;pointer-events:none;opacity:0;`;
      document.body.appendChild(d);
      probes.push(d);
      io.observe(d);
    }
    apply();

    return () => {
      io.disconnect();
      probes.forEach((p) => p.remove());
      root.style.removeProperty('--app-vw');
    };
  }, []);

  return tier;
}
