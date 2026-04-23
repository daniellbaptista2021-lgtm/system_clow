// app.jsx — System Clow video 16:9 YouTube 1920x1080, 45s

// ────────────────────────────────────────────────────────────────────
// AudioSync — <audio> atrelado ao Stage/TimelineContext.
// play() quando playing=true, pause() quando false, seek quando drift>.3s
// Loop do Stage reseta time pra 0 -> audio segue junto
// ────────────────────────────────────────────────────────────────────
function AudioSync({ src, volume = 0.8 }) {
  const { time, playing } = React.useContext(TimelineContext);
  const ref = React.useRef(null);
  const lastSeekRef = React.useRef(0);

  // play/pause quando playing muda
  React.useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.volume = volume;
    if (playing) {
      const p = a.play();
      if (p && p.catch) p.catch(() => { /* autoplay bloqueado, user gesture handler abaixo destravara */ });
    } else {
      a.pause();
    }
  }, [playing, volume]);

  // sincroniza currentTime quando driftar muito do Stage time (loop/seek manual)
  React.useEffect(() => {
    const a = ref.current;
    if (!a || a.readyState < 1) return;
    const drift = a.currentTime - time;
    // Se Stage voltou (loop) ou o user scrubou -> seek
    if (Math.abs(drift) > 0.3) {
      // Evita seek se ja seekou no mesmo time muito recentemente
      const now = performance.now();
      if (now - lastSeekRef.current > 100) {
        a.currentTime = Math.max(0, Math.min(time, a.duration || time));
        lastSeekRef.current = now;
      }
    }
  }, [time]);

  // Fallback: primeiro click/touch destrava autoplay
  React.useEffect(() => {
    const unlock = () => {
      const a = ref.current;
      if (a && playing) {
        a.play().catch(() => {});
      }
      document.removeEventListener('click', unlock, true);
      document.removeEventListener('touchstart', unlock, true);
    };
    document.addEventListener('click', unlock, true);
    document.addEventListener('touchstart', unlock, true);
    return () => {
      document.removeEventListener('click', unlock, true);
      document.removeEventListener('touchstart', unlock, true);
    };
  }, []);

  return (
    <audio ref={ref} src={src} preload="auto" loop={false} style={{ display: 'none' }} />
  );
}


function Video() {
  return (
    <Stage
      width={1920}
      height={1080}
      duration={45}
      background={PAL.bg0}
      persistKey="system-clow-video-yt"
    >
      <VideoRoot/>
    </Stage>
  );
}

function VideoRoot() {
  return (
    <div data-video-root data-screen-label="video" style={{ position: 'absolute', inset: 0 }}>
      {/* Background */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(ellipse at 50% 30%, ${PAL.bg1} 0%, ${PAL.bg0} 70%)`,
      }}/>
      <GridBg opacity={0.4}/>
      <Particles n={32}/>

      <TimestampLabel/>

      {/* Progress ticks */}
      <SceneProgress/>

      {/* Header logo for middle scenes */}
      <HeaderLayer/>

      {/* Scenes */}
      <Sprite start={0}    end={4}>   <Scene1/>    </Sprite>
      <Sprite start={4}    end={9}>   <Scene2/>    </Sprite>
      <Sprite start={9}    end={13}>  <Scene3/>    </Sprite>
      <Sprite start={13}   end={18}>  <Scene4/>    </Sprite>
      <Sprite start={18}   end={24}>  <Scene5/>    </Sprite>
      <Sprite start={24}   end={29}>  <Scene6/>    </Sprite>
      <Sprite start={29}   end={33}>  <Scene7/>    </Sprite>
      <Sprite start={33}   end={37}>  <Scene8/>    </Sprite>
      <Sprite start={37}   end={42}>  <Scene9/>    </Sprite>
      <Sprite start={42}   end={45}>  <SceneCTA/>  </Sprite>

      {/* Trilha sonora acoplada ao play/pause do Stage */}
      <AudioSync src="assets/track.mp3" volume={0.85}/>
    </div>
  );
}

function HeaderLayer() {
  const t = useTime();
  const visible = t >= 4 && t < 42;
  const op = visible ? (t < 4.5 ? (t - 4) / 0.5 : t > 41.5 ? (42 - t) / 0.5 : 1) : 0;
  return (
    <div style={{
      position: 'absolute',
      left: 60, top: 50,
      opacity: clamp(op, 0, 1),
      pointerEvents: 'none',
    }}>
      <ClowLogo height={54}/>
    </div>
  );
}

function SceneProgress() {
  const t = useTime();
  const segments = [
    { start: 0,  end: 4 },
    { start: 4,  end: 9 },
    { start: 9,  end: 13 },
    { start: 13, end: 18 },
    { start: 18, end: 24 },
    { start: 24, end: 29 },
    { start: 29, end: 33 },
    { start: 33, end: 37 },
    { start: 37, end: 42 },
    { start: 42, end: 45 },
  ];
  return (
    <div style={{
      position: 'absolute',
      top: 26, left: 80, right: 80,
      height: 3,
      display: 'flex', gap: 6,
      pointerEvents: 'none',
      zIndex: 50,
    }}>
      {segments.map((s, i) => {
        const p = clamp((t - s.start) / (s.end - s.start), 0, 1);
        return (
          <div key={i} style={{
            flex: 1,
            background: 'rgba(255,255,255,0.14)',
            borderRadius: 2,
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${p * 100}%`,
              height: '100%',
              background: PAL.grad,
            }}/>
          </div>
        );
      })}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Video/>);
