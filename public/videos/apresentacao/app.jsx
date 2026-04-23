// app.jsx — System Clow video 16:9 YouTube 1920x1080, 45s

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
