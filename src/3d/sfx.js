/**
 * sfx —— WebAudio 实时合成音效（不引入任何音频文件）
 *
 * 用法：
 *   var SFX = __req("sfx").create();     // 注意：create 不需要参数
 *   SFX.setVolume(0.35);                 // 0~1，默认 0.35
 *   SFX.setEnabled(true);                // 关掉后 play() 直接返回 false，不建 AudioContext
 *   SFX.play("pat");                     // 见下表；未知名字静默返回 false
 *   SFX.isEnabled();
 *   SFX.dispose();                       // 关掉 AudioContext，之后 play() 不再发声
 *
 * 音色表（全部用 Oscillator + Gain + 可选 BiquadFilter 现场合成）：
 *   pat      拍一拍       A5(880)→E6(1318) 两音上行，三角波，像“啾”
 *   pop      “啵”         正弦 420→170Hz 90ms 下滑，弹一下
 *   chime    好感 +1      C6 + G6 双正弦泛音，0.6s 指数衰减的小铃铛
 *   levelup  升级          C5-E5-G5-C6 琶音（三角波），尾巴两颗高音亮片
 *   error    失败/拒绝     G4→C4 两音下行，方波过 1.1kHz 低通，有点委屈
 *   wake     睡醒          330→990Hz 上扬滑音 + 6.5Hz 揉弦 + 尾音轻铃
 *   hide     收起          700→220Hz 下滑 + 低通收暗 + 一记闷“啵”
 *   show     展开          440→880Hz 短促上扬 + 高音亮片
 *   nom      吃东西        260→170 / 300→190 两声低通三角“吧唧”
 *   spin     转圈          200→1200Hz 锯齿扫频 + 带通渐开 + 尾音亮片，呼——
 *
 * 设计原则：
 *   - AudioContext 懒创建：第一次 play() 才 new，并在 play() 里尝试 resume()，绕开浏览器
 *     自动播放限制；创建/恢复失败一律静默降级（failed 标记），页面绝不抛异常；
 *   - 每个音是若干个临时节点，stop() 后 onended 里 disconnect()，不留悬挂节点；
 *   - 主 Gain 就是全局音量（默认 0.35），单个音峰值 ≤ 0.2，叠加也不容易削波；
 *   - 不写 localStorage、不读配置：开关/音量由 pet3d 的设置层自己持久化后传进来。
 */

module.exports.create = function () {
  var DEFAULT_VOLUME = 0.35;
  var TAU = Math.PI * 2;

  var ctx = null;
  var master = null;
  var enabled = true;
  var volume = DEFAULT_VOLUME;
  var disposed = false;
  var failed = false;    // 环境不支持 / 创建失败 —— 永久静音降级
  var started = 0;       // 已调度音效数（调试用）

  function now() {
    try { return ctx ? ctx.currentTime : 0; } catch (e) { return 0; }
  }

  /** 懒创建 AudioContext；失败就把 failed 立起来，之后全部静默 */
  function ensure() {
    if (disposed || failed) return null;
    if (!ctx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { failed = true; return null; }
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = enabled ? volume : 0;
        master.connect(ctx.destination);
      } catch (e) {
        failed = true;
        ctx = null;
        master = null;
        return null;
      }
    }
    if (ctx.state === "suspended") {
      try {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    }
    return ctx;
  }

  /**
   * 一个"音"：振荡器 →（可选滤波）→ 包络 Gain → 主音量。
   * o = {type, f0, f1, glide, t0, dur, peak, attack, detune,
   *      filter:{type, f0, f1, q, glide}, vibrato:{rate, depth}}
   */
  function voice(o) {
    if (!ctx || !master) return;
    var t0 = o.t0;
    var dur = Math.max(0.03, o.dur);
    var peak = Math.max(0.0001, o.peak == null ? 0.1 : o.peak);
    var attack = Math.min(o.attack == null ? 0.006 : o.attack, dur * 0.6);
    var os = null, g = null, nodes = [];
    try {
      os = ctx.createOscillator();
      g = ctx.createGain();
      nodes.push(os, g);

      os.type = o.type || "sine";
      var f0 = Math.max(8, o.f0 || 440);
      os.frequency.setValueAtTime(f0, t0);
      if (o.f1 != null && o.f1 > 0 && o.f1 !== f0) {
        os.frequency.exponentialRampToValueAtTime(Math.max(8, o.f1), t0 + Math.max(0.01, o.glide || dur));
      }
      if (o.detune) os.detune.setValueAtTime(o.detune, t0);

      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + Math.max(0.001, attack));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.012);

      if (o.filter) {
        var bq = ctx.createBiquadFilter();
        nodes.push(bq);
        bq.type = o.filter.type || "lowpass";
        var ff0 = Math.max(20, o.filter.f0 || 2000);
        bq.frequency.setValueAtTime(ff0, t0);
        if (o.filter.f1 != null && o.filter.f1 > 0 && o.filter.f1 !== ff0) {
          bq.frequency.exponentialRampToValueAtTime(Math.max(20, o.filter.f1), t0 + Math.max(0.01, o.filter.glide || dur));
        }
        if (o.filter.q != null) {
          try { bq.Q.setValueAtTime(o.filter.q, t0); } catch (e) {}
        }
        os.connect(bq);
        bq.connect(g);
      } else {
        os.connect(g);
      }
      g.connect(master);

      if (o.vibrato) {
        var lfo = ctx.createOscillator();
        var lfoGain = ctx.createGain();
        nodes.push(lfo, lfoGain);
        lfo.type = "sine";
        lfo.frequency.setValueAtTime(o.vibrato.rate || 6, t0);
        lfoGain.gain.setValueAtTime(o.vibrato.depth || 8, t0);
        lfo.connect(lfoGain);
        lfoGain.connect(os.frequency);
        lfo.start(t0);
        lfo.stop(t0 + dur + 0.03);
      }

      os.start(t0);
      os.stop(t0 + dur + 0.02);
      os.onended = function () {
        for (var i = 0; i < nodes.length; i++) {
          try { nodes[i].disconnect(); } catch (e) {}
        }
        nodes.length = 0;
      };
      started++;
    } catch (e) {
      // 单个音失败不影响其它音；把可能半连接的节点清掉
      for (var i = 0; i < nodes.length; i++) {
        try { nodes[i].disconnect(); } catch (e2) {}
      }
      try { if (os) os.stop(); } catch (e3) {}
    }
  }

  /* ============================ 音色 ============================ */
  var SOUNDS = {
    // 拍一拍：上行两音 + 一点高音亮片
    pat: function (T) {
      voice({ type: "triangle", f0: 880, f1: 1174.66, t0: T, dur: 0.085, peak: 0.16, attack: 0.004, glide: 0.06 });
      voice({ type: "sine", f0: 1318.51, f1: 1567.98, t0: T + 0.07, dur: 0.16, peak: 0.13, attack: 0.005 });
      voice({ type: "sine", f0: 2637.02, t0: T + 0.085, dur: 0.10, peak: 0.03, attack: 0.004 });
    },
    // “啵”：短促正弦下滑
    pop: function (T) {
      voice({ type: "sine", f0: 420, f1: 170, t0: T, dur: 0.09, peak: 0.20, attack: 0.003, glide: 0.085 });
      voice({ type: "triangle", f0: 840, f1: 320, t0: T, dur: 0.045, peak: 0.05, attack: 0.002 });
    },
    // 小铃铛：C6/G6 泛音 + 一点低音垫
    chime: function (T) {
      voice({ type: "sine", f0: 1046.50, t0: T, dur: 0.55, peak: 0.10, attack: 0.008 });
      voice({ type: "sine", f0: 1567.98, t0: T + 0.01, dur: 0.62, peak: 0.06, attack: 0.008 });
      voice({ type: "sine", f0: 2093.00, t0: T + 0.02, dur: 0.40, peak: 0.035, attack: 0.01 });
      voice({ type: "triangle", f0: 523.25, t0: T, dur: 0.30, peak: 0.05, attack: 0.01 });
    },
    // 升级：C5-E5-G5-C6 琶音
    levelup: function (T) {
      var seq = [523.25, 659.25, 783.99, 1046.50];
      for (var i = 0; i < seq.length; i++) {
        var last = i === seq.length - 1;
        voice({
          type: "triangle", f0: seq[i], t0: T + i * 0.072,
          dur: last ? 0.34 : 0.10, peak: last ? 0.13 : 0.10,
          attack: 0.004,
        });
      }
      voice({ type: "sine", f0: 2093.00, t0: T + 0.24, dur: 0.35, peak: 0.04, attack: 0.006 });
      voice({ type: "sine", f0: 2637.00, t0: T + 0.30, dur: 0.30, peak: 0.03, attack: 0.006 });
    },
    // 失败 / 拒绝：两音下行方波（低通压软）
    error: function (T) {
      voice({ type: "square", f0: 392.00, f1: 370.00, t0: T, dur: 0.13, peak: 0.075, attack: 0.004, filter: { type: "lowpass", f0: 1400, q: 2 } });
      voice({ type: "square", f0: 261.63, f1: 233.08, t0: T + 0.145, dur: 0.20, peak: 0.09, attack: 0.005, filter: { type: "lowpass", f0: 1100, q: 2 } });
      voice({ type: "sine", f0: 130.81, t0: T + 0.145, dur: 0.18, peak: 0.05, attack: 0.005 });
    },
    // 睡醒：上扬滑音 + 揉弦
    wake: function (T) {
      voice({ type: "sine", f0: 330, f1: 990, t0: T, dur: 0.42, peak: 0.11, attack: 0.03, glide: 0.38, vibrato: { rate: 6.5, depth: 14 } });
      voice({ type: "triangle", f0: 495, f1: 1485, t0: T + 0.02, dur: 0.38, peak: 0.05, attack: 0.04, glide: 0.34 });
      voice({ type: "sine", f0: 1567.98, t0: T + 0.34, dur: 0.30, peak: 0.05, attack: 0.008 });
    },
    // 收起：下滑 + 一记闷“啵”
    hide: function (T) {
      voice({ type: "triangle", f0: 700, f1: 220, t0: T, dur: 0.26, peak: 0.13, attack: 0.01, glide: 0.22, filter: { type: "lowpass", f0: 1800, f1: 500 } });
      voice({ type: "sine", f0: 180, f1: 120, t0: T + 0.17, dur: 0.12, peak: 0.10, attack: 0.004 });
    },
    // 展开：短促上扬 + 亮片
    show: function (T) {
      voice({ type: "sine", f0: 440, f1: 880, t0: T, dur: 0.16, peak: 0.13, attack: 0.005, glide: 0.13 });
      voice({ type: "sine", f0: 1760, t0: T + 0.12, dur: 0.16, peak: 0.05, attack: 0.004 });
    },
    // 吃东西：两声低通三角“吧唧”
    nom: function (T) {
      voice({ type: "triangle", f0: 260, f1: 170, t0: T, dur: 0.07, peak: 0.15, attack: 0.004, filter: { type: "lowpass", f0: 900, q: 1 } });
      voice({ type: "sine", f0: 520, f1: 340, t0: T + 0.01, dur: 0.06, peak: 0.04, attack: 0.003 });
      voice({ type: "triangle", f0: 300, f1: 190, t0: T + 0.10, dur: 0.08, peak: 0.13, attack: 0.004, filter: { type: "lowpass", f0: 900, q: 1 } });
    },
    // 转圈：锯齿扫频 + 带通渐开
    spin: function (T) {
      voice({
        type: "sawtooth", f0: 200, f1: 1200, t0: T, dur: 0.38, peak: 0.10, attack: 0.05, glide: 0.36,
        filter: { type: "bandpass", f0: 320, f1: 2400, q: 2.5 },
      });
      voice({ type: "sine", f0: 400, f1: 1600, t0: T + 0.02, dur: 0.30, peak: 0.05, attack: 0.06, glide: 0.28 });
      voice({ type: "sine", f0: 2093, t0: T + 0.30, dur: 0.16, peak: 0.04, attack: 0.005 });
    },
  };

  function clamp01(v) {
    v = +v;
    if (!isFinite(v)) return DEFAULT_VOLUME;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function applyVolume() {
    if (!master || !ctx) return;
    var target = enabled ? volume : 0;
    try {
      if (master.gain.setTargetAtTime) master.gain.setTargetAtTime(target, ctx.currentTime, 0.02);
      else master.gain.value = target;
    } catch (e) {
      try { master.gain.value = target; } catch (e2) {}
    }
  }

  return {
    /** 播放一个音效；返回是否真的调度了（不支持 / 被关掉 / 未知名字都返回 false） */
    play: function (name) {
      if (disposed || !enabled) return false;
      try {
        if (!ensure()) return false;
        var fn = SOUNDS[name];
        if (typeof fn !== "function") return false;
        fn(now() + 0.012);
        return true;
      } catch (e) {
        return false;
      }
    },
    setEnabled: function (on) {
      enabled = !!on;
      applyVolume();
      return enabled;
    },
    isEnabled: function () { return enabled; },
    setVolume: function (v) {
      volume = clamp01(v);
      applyVolume();
      return volume;
    },
    getVolume: function () { return volume; },
    /** 可用音效名（调试 / 文档用） */
    names: function () { return Object.keys(SOUNDS); },
    /** 运行状态快照（验收用） */
    stats: function () {
      return {
        enabled: enabled, volume: volume, started: started,
        hasContext: !!ctx, contextState: ctx ? ctx.state : "none",
        failed: failed, disposed: disposed,
      };
    },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      var c = ctx;
      ctx = null;
      master = null;
      try {
        if (c && c.close) {
          var p = c.close();
          if (p && p.catch) p.catch(function () {});
        }
      } catch (e) {}
    },
  };
};
