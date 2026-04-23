// scenes.jsx — Cenas do video System Clow (16:9 YouTube, 1920x1080, 45s)

// ─── Paleta oficial (preto + roxo) ─────────────────────────────────────
const PAL = {
  bg0: '#05060A',
  bg1: '#0A0815',
  violet: '#7C5CFF',
  violetLight: '#A78BFA',
  violetDeep: '#4B2FBD',
  text: '#F4F5FB',
  textDim: 'rgba(244,245,251,0.62)',
  grad: 'linear-gradient(135deg, #A78BFA 0%, #7C5CFF 55%, #4B2FBD 100%)',
  gradSoft: 'linear-gradient(135deg, rgba(167,139,250,0.2) 0%, rgba(124,92,255,0.2) 100%)',
};

// ─── Logo oficial (PNG) ────────────────────────────────────────────────
function ClowLogo({ height = 64, opacity = 1 }) {
  return (
    <img
      src="assets/logo-clean.png"
      alt="System Clow"
      style={{
        height,
        width: 'auto',
        display: 'block',
        opacity,
        filter: 'drop-shadow(0 4px 20px rgba(124,92,255,0.4))',
      }}
    />
  );
}

// Apenas o símbolo infinito oficial (extraído em CSS via clip)
function ClowMark({ height = 64, opacity = 1 }) {
  // logo-clean.png é 431×62 aprox; o infinito ocupa ~0 a 26% da largura
  return (
    <div style={{
      height,
      width: height * (431 * 0.28 / 62),
      overflow: 'hidden',
      display: 'inline-block',
      opacity,
    }}>
      <img
        src="assets/logo-clean.png"
        alt=""
        style={{
          height: '100%',
          width: 'auto',
          display: 'block',
          filter: 'drop-shadow(0 4px 20px rgba(124,92,255,0.5))',
        }}
      />
    </div>
  );
}

// ─── Ícones SVG profissionais (Lucide-style, stroke only) ──────────────
const Icon = {
  Code: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
    </svg>
  ),
  Globe: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/>
    </svg>
  ),
  Layout: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
    </svg>
  ),
  Smartphone: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/>
    </svg>
  ),
  Monitor: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  ),
  MessageCircle: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  ),
  BarChart: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/><line x1="3" y1="20" x2="21" y2="20"/>
    </svg>
  ),
  Zap: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  Target: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
    </svg>
  ),
  CreditCard: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
    </svg>
  ),
  GitBranch: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
    </svg>
  ),
  ArrowRight: ({ size = 24, color = '#A78BFA', strokeWidth = 2 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  ),
  Check: ({ size = 24, color = '#A78BFA', strokeWidth = 2.5 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  FileSpreadsheet: ({ size = 48, color = '#A78BFA', strokeWidth = 1.8 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>
    </svg>
  ),
};

// ─── Grid / malha de fundo ─────────────────────────────────────────────
function GridBg({ opacity = 0.4 }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      backgroundImage: `
        linear-gradient(rgba(124,92,255,0.08) 1px, transparent 1px),
        linear-gradient(90deg, rgba(124,92,255,0.08) 1px, transparent 1px)
      `,
      backgroundSize: '64px 64px',
      maskImage: 'radial-gradient(ellipse at center, rgba(0,0,0,1) 20%, rgba(0,0,0,0.15) 85%)',
      opacity,
      pointerEvents: 'none',
    }}/>
  );
}

// ─── Halo radial pulsante ──────────────────────────────────────────────
function Halo({ x = '50%', y = '50%', size = 1400, color = PAL.violet, intensity = 0.4 }) {
  const t = useTime();
  const pulse = 0.82 + 0.18 * Math.sin(t * 2.0);
  const hex = Math.round(intensity * 255).toString(16).padStart(2,'0');
  return (
    <div style={{
      position: 'absolute',
      left: x, top: y,
      width: size, height: size,
      marginLeft: -size / 2, marginTop: -size / 2,
      background: `radial-gradient(circle, ${color}${hex} 0%, transparent 60%)`,
      filter: 'blur(60px)',
      opacity: pulse,
      pointerEvents: 'none',
    }}/>
  );
}

// ─── Partículas determinísticas ───────────────────────────────────────
function Particles({ n = 30 }) {
  const t = useTime();
  const dots = React.useMemo(() =>
    Array.from({ length: n }).map((_, i) => {
      const s1 = ((i * 9301 + 49297) % 233280) / 233280;
      const s2 = ((i * 31 + 7) % 97) / 97;
      return { x: s1 * 100, y: s2 * 100, size: 1 + s1 * 3, speed: 0.15 + s2 * 0.4 };
    }), [n]
  );
  return (
    <>
      {dots.map((d, i) => {
        const y = (d.y + t * d.speed * 2) % 100;
        return (
          <div key={i} style={{
            position: 'absolute',
            left: `${d.x}%`, top: `${y}%`,
            width: d.size, height: d.size,
            background: PAL.violetLight,
            borderRadius: '50%',
            opacity: 0.45,
            boxShadow: `0 0 ${d.size * 4}px ${PAL.violetLight}`,
          }}/>
        );
      })}
    </>
  );
}

// ─── Caption (kinetic typography, centro-inferior) ─────────────────────
function Caption({ children, accent = [] }) {
  const { localTime, duration } = useSprite();
  const entry = 0.3, exit = 0.25;
  let op = 1, ty = 0;
  if (localTime < entry) {
    const p = Easing.easeOutCubic(clamp(localTime / entry, 0, 1));
    op = p; ty = (1 - p) * 20;
  } else if (localTime > duration - exit) {
    const p = Easing.easeInCubic(clamp((localTime - (duration - exit)) / exit, 0, 1));
    op = 1 - p; ty = -p * 10;
  }
  return (
    <div style={{
      position: 'absolute',
      left: 0, right: 0, bottom: 80,
      textAlign: 'center',
      opacity: op,
      transform: `translateY(${ty}px)`,
      padding: '0 120px',
    }}>
      <div style={{
        display: 'inline-block',
        padding: '22px 36px',
        background: 'rgba(5,6,10,0.72)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: '1px solid rgba(167,139,250,0.22)',
        borderRadius: 22,
      }}>
        <div style={{
          fontFamily: 'Inter, system-ui',
          fontWeight: 700,
          fontSize: 52,
          lineHeight: 1.15,
          letterSpacing: '-0.02em',
          color: PAL.text,
          textWrap: 'pretty',
        }}>
          {renderCaption(children, accent)}
        </div>
      </div>
    </div>
  );
}

function renderCaption(text, accent) {
  if (!accent.length) return text;
  const pattern = new RegExp(`(${accent.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const segs = text.split(pattern);
  return segs.map((s, k) => {
    if (accent.some(a => s.toLowerCase() === a.toLowerCase())) {
      return (
        <span key={k} style={{
          background: PAL.grad,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}>{s}</span>
      );
    }
    return <span key={k}>{s}</span>;
  });
}

// ─── Timestamp tag ─────────────────────────────────────────────────────
function TimestampLabel() {
  const t = useTime();
  React.useEffect(() => {
    const root = document.querySelector('[data-video-root]');
    if (root) root.setAttribute('data-screen-label', `t=${t.toFixed(1)}s`);
  }, [Math.floor(t)]);
  return null;
}

// ─── Screenshot frame ──────────────────────────────────────────────────
function ScreenFrame({ src, width, height, x, y, zoomFrom = 1, zoomTo = 1.1, panX = 0, panY = 0 }) {
  const { progress } = useSprite();
  const scale = zoomFrom + (zoomTo - zoomFrom) * Easing.easeInOutSine(progress);
  return (
    <div style={{
      position: 'absolute',
      left: x, top: y,
      width, height,
      borderRadius: 20,
      overflow: 'hidden',
      border: '1px solid rgba(167,139,250,0.28)',
      boxShadow: '0 40px 100px rgba(124,92,255,0.3), 0 0 0 1px rgba(255,255,255,0.04)',
    }}>
      <img src={src} style={{
        width: '100%', height: '100%',
        objectFit: 'cover',
        objectPosition: 'center top',
        transform: `scale(${scale}) translate(${panX * progress}px, ${panY * progress}px)`,
        transformOrigin: 'center',
      }}/>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// SCENE 1 · [0–4] Intro logo
// ═════════════════════════════════════════════════════════════════════
function Scene1() {
  const { localTime } = useSprite();
  const logoScale = 0.65 + Easing.easeOutBack(clamp(localTime / 0.9, 0, 1)) * 0.35;
  const logoOp = clamp(localTime / 0.4, 0, 1);
  const burst = clamp((localTime - 0.6) / 0.9, 0, 1);

  return (
    <>
      <Halo x="50%" y="45%" size={1400} color={PAL.violet} intensity={0.55}/>
      <Halo x="30%" y="55%" size={900} color={PAL.violetDeep} intensity={0.4}/>

      {Array.from({length: 14}).map((_, i) => {
        const angle = (i / 14) * Math.PI * 2;
        const dist = burst * 700;
        return (
          <div key={i} style={{
            position: 'absolute',
            left: '50%', top: '45%',
            width: 2, height: 70,
            background: PAL.violetLight,
            transform: `translate(-50%, -50%) rotate(${angle}rad) translateY(-${dist * 0.35 + 100}px)`,
            opacity: (1 - burst) * 0.65,
            boxShadow: `0 0 16px ${PAL.violetLight}`,
          }}/>
        );
      })}

      <div style={{
        position: 'absolute',
        left: '50%', top: '42%',
        transform: `translate(-50%, -50%) scale(${logoScale})`,
        opacity: logoOp,
      }}>
        <ClowLogo height={180}/>
      </div>

      {/* Tagline */}
      <Tagline/>

      <Caption accent={['um só sistema.']}>Imagina tudo num só sistema.</Caption>
    </>
  );
}

function Tagline() {
  const { localTime } = useSprite();
  const op = clamp((localTime - 1.3) / 0.5, 0, 1) * (1 - clamp((localTime - 3.4) / 0.4, 0, 1));
  return (
    <div style={{
      position: 'absolute',
      left: 0, right: 0, top: '62%',
      textAlign: 'center',
      opacity: op,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 20,
      fontWeight: 600,
      color: PAL.violetLight,
      letterSpacing: '0.25em',
    }}>
      INTELIGÊNCIA INFINITA · POSSIBILIDADES PREMIUM
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// SCENE 2 · [4–9] IA full-stack
// ═════════════════════════════════════════════════════════════════════
function Scene2() {
  return (
    <>
      <Halo x="30%" y="50%" size={1200} color={PAL.violet} intensity={0.4}/>

      {/* Left column: screenshot */}
      <ScreenFrame src="assets/hero.png" x={80} y={180} width={900} height={680} zoomFrom={1.05} zoomTo={1.15}/>

      {/* Right column: feature badges stacked */}
      <div style={{
        position: 'absolute',
        left: 1060, top: 220,
        display: 'flex', flexDirection: 'column', gap: 28,
      }}>
        <FeatureBadge delay={0.3} IconC={Icon.Globe} label="SITES"/>
        <FeatureBadge delay={0.6} IconC={Icon.Layout} label="LANDING PAGES"/>
        <FeatureBadge delay={0.9} IconC={Icon.Code} label="APPS"/>
      </div>

      <Caption accent={['full-stack', 'sites', 'landing pages', 'apps']}>
        IA full-stack que cria sites, landing pages e apps.
      </Caption>
    </>
  );
}

function FeatureBadge({ IconC, label, delay = 0 }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.5, 0, 1);
  const op = Easing.easeOutCubic(t);
  const tx = (1 - t) * 80;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 20,
      padding: '22px 32px',
      background: 'rgba(10,8,21,0.72)',
      border: '1px solid rgba(167,139,250,0.3)',
      borderRadius: 18,
      opacity: op,
      transform: `translateX(${tx}px)`,
      backdropFilter: 'blur(10px)',
      width: 440,
      boxShadow: '0 16px 40px rgba(124,92,255,0.22)',
    }}>
      <div style={{
        width: 64, height: 64,
        background: 'rgba(124,92,255,0.15)',
        border: '1px solid rgba(167,139,250,0.4)',
        borderRadius: 14,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <IconC size={36} color={PAL.violetLight}/>
      </div>
      <div style={{
        fontFamily: 'Inter, system-ui',
        fontWeight: 700,
        fontSize: 30,
        letterSpacing: '0.04em',
        color: PAL.text,
      }}>{label}</div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// SCENE 3 · [9–13] Planilhas + dashboards
// ═════════════════════════════════════════════════════════════════════
function Scene3() {
  return (
    <>
      <Halo x="70%" y="40%" size={1100} color={PAL.violet} intensity={0.35}/>

      <ScreenFrame src="assets/dashboard.png" x={80} y={180} width={1100} height={700} zoomFrom={1.0} zoomTo={1.1}/>

      {/* Right column: callouts */}
      <div style={{
        position: 'absolute',
        left: 1240, top: 220,
        display: 'flex', flexDirection: 'column', gap: 22,
      }}>
        <DataCallout delay={0.2} IconC={Icon.BarChart} label="PIPELINE" value="R$ 897"/>
        <DataCallout delay={0.5} IconC={Icon.FileSpreadsheet} label="PLANILHAS" value="AUTO"/>
        <DataCallout delay={0.8} IconC={Icon.Target} label="FORECAST" value="R$ 627"/>
      </div>

      <Caption accent={['automatizadas', 'dashboards', 'segundos']}>
        Planilhas automatizadas e dashboards em segundos.
      </Caption>
    </>
  );
}

function DataCallout({ IconC, label, value, delay = 0 }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.5, 0, 1);
  const op = Easing.easeOutCubic(t);
  const scale = 0.85 + 0.15 * Easing.easeOutBack(t);
  return (
    <div style={{
      width: 400,
      padding: '20px 26px',
      background: 'rgba(10,8,21,0.85)',
      border: '1px solid rgba(167,139,250,0.35)',
      borderRadius: 16,
      display: 'flex', alignItems: 'center', gap: 18,
      opacity: op,
      transform: `scale(${scale})`,
      transformOrigin: 'left center',
      boxShadow: '0 14px 40px rgba(124,92,255,0.28)',
    }}>
      <IconC size={40} color={PAL.violetLight}/>
      <div>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 13, color: PAL.textDim, letterSpacing: '0.1em',
        }}>{label}</div>
        <div style={{
          fontFamily: 'Inter', fontWeight: 700, fontSize: 30,
          background: PAL.grad,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}>{value}</div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// SCENE 4 · [13–18] WhatsApp + CRM
// ═════════════════════════════════════════════════════════════════════
function Scene4() {
  return (
    <>
      <Halo x="75%" y="55%" size={1100} color={PAL.violet} intensity={0.4}/>
      <Halo x="25%" y="50%" size={800} color={PAL.violetDeep} intensity={0.35}/>

      <ScreenFrame src="assets/crm-pipeline.png" x={760} y={180} width={1080} height={680} zoomFrom={1.02} zoomTo={1.1} panX={-30}/>

      {/* Left: whatsapp-style chat (paleta dark+violeta, sem verde WA) */}
      <div style={{
        position: 'absolute',
        left: 80, top: 200, width: 620,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <ChatHeader delay={0}/>
        <ChatBubble delay={0.3} inbound text="Quero saber sobre o plano Premium"/>
        <ChatBubble delay={0.9} text="Claro! Posso te qualificar em 2 minutos."/>
        <ChatStatus delay={1.6}/>
      </div>

      <Caption accent={['WhatsApp 24/7', 'CRM', 'sozinha']}>
        Atende no WhatsApp 24/7 e move o card no CRM sozinha.
      </Caption>
    </>
  );
}

function ChatHeader({ delay = 0 }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.5, 0, 1);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '16px 22px',
      background: 'rgba(10,8,21,0.85)',
      border: '1px solid rgba(167,139,250,0.25)',
      borderRadius: 16,
      opacity: Easing.easeOutCubic(t),
      backdropFilter: 'blur(10px)',
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: '50%',
        background: PAL.grad,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon.MessageCircle size={24} color="#fff" strokeWidth={2}/>
      </div>
      <div>
        <div style={{ fontSize: 20, fontWeight: 600, color: PAL.text }}>Lead · WhatsApp</div>
        <div style={{ fontSize: 14, color: PAL.violetLight, fontFamily: 'JetBrains Mono, monospace' }}>online · IA ativa</div>
      </div>
    </div>
  );
}

function ChatBubble({ text, inbound = false, delay = 0 }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.5, 0, 1);
  const op = Easing.easeOutCubic(t);
  const tx = (1 - t) * (inbound ? -40 : 40);
  return (
    <div style={{
      display: 'flex', justifyContent: inbound ? 'flex-start' : 'flex-end',
      opacity: op, transform: `translateX(${tx}px)`,
    }}>
      <div style={{
        maxWidth: 480,
        padding: '16px 22px',
        background: inbound
          ? 'rgba(10,8,21,0.85)'
          : PAL.grad,
        border: inbound ? '1px solid rgba(167,139,250,0.3)' : 'none',
        borderRadius: inbound ? '18px 18px 18px 4px' : '18px 18px 4px 18px',
        color: inbound ? PAL.text : '#fff',
        fontFamily: 'Inter',
        fontSize: 22,
        fontWeight: 500,
        lineHeight: 1.3,
        boxShadow: inbound ? 'none' : '0 10px 30px rgba(124,92,255,0.4)',
      }}>
        {text}
      </div>
    </div>
  );
}

function ChatStatus({ delay = 0 }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.6, 0, 1);
  if (t <= 0) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '14px 20px',
      background: 'rgba(124,92,255,0.18)',
      border: '1px solid rgba(167,139,250,0.5)',
      borderRadius: 14,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 18,
      fontWeight: 600,
      color: PAL.violetLight,
      opacity: Easing.easeOutCubic(t),
      transform: `translateY(${(1 - t) * 16}px)`,
      backdropFilter: 'blur(8px)',
    }}>
      <Icon.ArrowRight size={20} color={PAL.violetLight}/>
      <span>Lead novo → Qualificado</span>
      <Icon.Check size={20} color={PAL.violetLight}/>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// SCENE 5 · [18–24] Anúncios Meta + Google
// ═════════════════════════════════════════════════════════════════════
function Scene5() {
  return (
    <>
      <Halo x="50%" y="50%" size={1400} color={PAL.violet} intensity={0.4}/>

      <div style={{
        position: 'absolute',
        left: 0, right: 0, top: 200,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26,
      }}>
        <AdCard delay={0.2} IconC={Icon.Target} brand="Meta Ads" metric="CPA −38%"/>
        <AdCard delay={0.55} IconC={Icon.Zap} brand="Google Ads" metric="ROAS 4.2×"/>
        <AdCard delay={0.9} IconC={Icon.Code} brand="Copy · Criativo · Orçamento" metric="AUTO"/>
      </div>

      <Caption accent={['Meta Ads', 'Google Ads', 'sua conta']}>
        Cria e otimiza Meta Ads e Google Ads na sua conta.
      </Caption>
    </>
  );
}

function AdCard({ IconC, brand, metric, delay = 0 }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.5, 0, 1);
  const op = Easing.easeOutCubic(t);
  const tx = (1 - t) * 100;
  return (
    <div style={{
      width: 960,
      padding: '26px 36px',
      background: 'rgba(10,8,21,0.8)',
      border: '1px solid rgba(167,139,250,0.35)',
      borderRadius: 20,
      display: 'flex', alignItems: 'center', gap: 26,
      opacity: op,
      transform: `translateX(${tx}px)`,
      boxShadow: '0 20px 50px rgba(124,92,255,0.3)',
      backdropFilter: 'blur(14px)',
    }}>
      <div style={{
        width: 72, height: 72,
        background: 'rgba(124,92,255,0.18)',
        border: '1px solid rgba(167,139,250,0.45)',
        borderRadius: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <IconC size={40} color={PAL.violetLight}/>
      </div>
      <div style={{
        flex: 1,
        fontFamily: 'Inter', fontWeight: 700, fontSize: 34, color: PAL.text,
      }}>{brand}</div>
      <div style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 24, fontWeight: 700,
        padding: '10px 20px',
        background: PAL.grad,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        border: '1px solid rgba(167,139,250,0.5)',
        borderRadius: 12,
      }}>{metric}</div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// SCENE 6 · [24–29] Debug + n8n + cobrança
// ═════════════════════════════════════════════════════════════════════
function Scene6() {
  return (
    <>
      <Halo x="35%" y="55%" size={1100} color={PAL.violet} intensity={0.4}/>

      <ScreenFrame src="assets/chat-code.png" x={80} y={180} width={1000} height={720} zoomFrom={1.0} zoomTo={1.12} panY={-50}/>

      <div style={{
        position: 'absolute',
        left: 1160, top: 220,
        display: 'flex', flexDirection: 'column', gap: 24,
      }}>
        <FeatureBadge delay={0.2} IconC={Icon.Code} label="DEBUG DE CÓDIGO"/>
        <FeatureBadge delay={0.55} IconC={Icon.GitBranch} label="FLUXOS n8n"/>
        <FeatureBadge delay={0.9} IconC={Icon.CreditCard} label="COBRANÇA RECORRENTE"/>
      </div>

      <Caption accent={['Debuga', 'fluxos n8n', 'mensalidade']}>
        Debuga código, desenha fluxos n8n e cobra mensalidade.
      </Caption>
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════
// SCENE 7 · [29–33] 3 portas
// ═════════════════════════════════════════════════════════════════════
function Scene7() {
  return (
    <>
      <Halo x="50%" y="50%" size={1400} color={PAL.violet} intensity={0.4}/>

      <div style={{
        position: 'absolute',
        left: 0, right: 0, top: 260,
        display: 'flex', justifyContent: 'center', gap: 40,
      }}>
        <DevicePortal delay={0.15} IconC={Icon.Monitor} label="NAVEGADOR"/>
        <DevicePortal delay={0.45} IconC={Icon.Smartphone} label="CELULAR"/>
        <DevicePortal delay={0.75} IconC={Icon.MessageCircle} label="WHATSAPP"/>
      </div>

      <CenteredLogo/>

      <Caption accent={['Mesma IA', '3 portas.']}>
        Mesma IA. 3 portas.
      </Caption>
    </>
  );
}

function CenteredLogo() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute',
      left: 0, right: 0, top: 770,
      display: 'flex', justifyContent: 'center', alignItems: 'center',
    }}>
      <ClowLogo height={56} opacity={clamp((localTime - 1.2) / 0.5, 0, 1)}/>
    </div>
  );
}

function DevicePortal({ IconC, label, delay = 0 }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.55, 0, 1);
  const op = Easing.easeOutCubic(t);
  const scale = 0.65 + 0.35 * Easing.easeOutBack(t);
  return (
    <div style={{
      width: 340, height: 400,
      padding: '40px 24px',
      background: 'rgba(10,8,21,0.75)',
      border: '1px solid rgba(167,139,250,0.35)',
      borderRadius: 26,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 30,
      opacity: op,
      transform: `scale(${scale})`,
      backdropFilter: 'blur(14px)',
      boxShadow: '0 24px 60px rgba(124,92,255,0.3)',
    }}>
      <div style={{
        width: 140, height: 140,
        background: PAL.gradSoft,
        border: '1px solid rgba(167,139,250,0.5)',
        borderRadius: 24,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <IconC size={80} color={PAL.violetLight} strokeWidth={1.5}/>
      </div>
      <div style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 22,
        fontWeight: 700,
        color: PAL.violetLight,
        letterSpacing: '0.12em',
      }}>{label}</div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// SCENE 8 · [33–37] 98% Claude Code
// ═════════════════════════════════════════════════════════════════════
function Scene8() {
  const { localTime } = useSprite();
  const numT = clamp(localTime / 1.3, 0, 1);
  const num = Math.floor(Easing.easeOutExpo(numT) * 98);
  const op = clamp(localTime / 0.3, 0, 1);

  return (
    <>
      <Halo x="50%" y="42%" size={1600} color={PAL.violet} intensity={0.55}/>
      <Halo x="50%" y="42%" size={700} color={PAL.violetDeep} intensity={0.6}/>

      <div style={{
        position: 'absolute',
        left: 0, right: 0, top: 180,
        textAlign: 'center',
        opacity: op,
      }}>
        <div style={{
          fontFamily: 'Inter',
          fontSize: 380,
          fontWeight: 800,
          lineHeight: 1,
          background: PAL.grad,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          letterSpacing: '-0.05em',
          filter: `drop-shadow(0 0 50px ${PAL.violet})`,
        }}>{num}%</div>
        <div style={{
          marginTop: 16,
          fontFamily: 'Inter',
          fontSize: 46,
          fontWeight: 600,
          color: PAL.text,
          letterSpacing: '-0.02em',
        }}>
          de paridade com <span style={{
            fontFamily: 'JetBrains Mono, monospace',
            background: PAL.grad,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>Claude Code</span>
        </div>
      </div>

      <Caption accent={['Zero complicação.']}>Zero complicação.</Caption>
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════
// SCENE 9 · [37–42] Stack consolidada
// ═════════════════════════════════════════════════════════════════════
function Scene9() {
  const { localTime } = useSprite();
  const tools = ['Pipedrive', 'WhatsApp Business', 'Make', 'Meta Ads', 'Dev freelance'];

  return (
    <>
      <Halo x="30%" y="50%" size={1100} color={PAL.violet} intensity={0.35}/>

      {/* Left: crossed-out list */}
      <div style={{
        position: 'absolute',
        left: 140, top: 220,
        width: 720,
      }}>
        {tools.map((tool, i) => {
          const appear = clamp((localTime - 0.12 * i) / 0.35, 0, 1);
          const cross = clamp((localTime - 2.0 - 0.06 * i) / 0.4, 0, 1);
          return (
            <div key={tool} style={{
              padding: '20px 28px',
              marginBottom: 16,
              background: 'rgba(10,8,21,0.7)',
              border: '1px solid rgba(167,139,250,0.25)',
              borderRadius: 16,
              fontFamily: 'Inter',
              fontSize: 30,
              fontWeight: 600,
              color: PAL.text,
              opacity: Easing.easeOutCubic(appear) * (1 - cross * 0.45),
              transform: `translateX(${(1 - Easing.easeOutCubic(appear)) * -40}px)`,
              position: 'relative',
              backdropFilter: 'blur(8px)',
            }}>
              {tool}
              <div style={{
                position: 'absolute',
                left: 20, right: 20 + (1 - cross) * 600,
                top: '50%',
                height: 3,
                background: PAL.violetLight,
                boxShadow: `0 0 14px ${PAL.violetLight}`,
                opacity: cross,
              }}/>
            </div>
          );
        })}
      </div>

      {/* Right: equals → single product */}
      <div style={{
        position: 'absolute',
        left: 960, top: 0, bottom: 0,
        width: 800,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          opacity: clamp((localTime - 1.5) / 0.5, 0, 1),
          fontFamily: 'Inter', fontSize: 120, fontWeight: 800,
          color: PAL.violetLight,
          lineHeight: 1,
          marginBottom: 24,
        }}>=</div>

        <div style={{
          opacity: clamp((localTime - 2.0) / 0.6, 0, 1),
          transform: `scale(${0.8 + 0.2 * Easing.easeOutBack(clamp((localTime - 2.0) / 0.7, 0, 1))})`,
          padding: '40px 50px',
          background: PAL.grad,
          borderRadius: 26,
          boxShadow: `0 30px 80px ${PAL.violet}88`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
        }}>
          <ClowLogo height={90}/>
          <div style={{
            fontFamily: 'Inter',
            fontSize: 34,
            fontWeight: 700,
            color: '#fff',
            letterSpacing: '-0.01em',
            borderTop: '1px solid rgba(255,255,255,0.35)',
            paddingTop: 18,
          }}>1 único produto</div>
        </div>
      </div>

      <Caption accent={['1 único produto.']}>Num único produto.</Caption>
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════
// SCENE 10 · [42–45] CTA final (sem URL)
// ═════════════════════════════════════════════════════════════════════
function SceneCTA() {
  const { localTime } = useSprite();
  const t0 = clamp(localTime / 0.5, 0, 1);
  const t1 = clamp((localTime - 0.3) / 0.7, 0, 1);
  const t2 = clamp((localTime - 0.9) / 0.5, 0, 1);

  return (
    <>
      {/* Radial deep-purple full-bleed (mantém preto + roxo) */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(ellipse at center, ${PAL.violetDeep} 0%, ${PAL.bg1} 55%, ${PAL.bg0} 100%)`,
        opacity: Easing.easeOutCubic(t0),
      }}/>

      {/* Logo */}
      <div style={{
        position: 'absolute',
        left: '50%', top: '42%',
        transform: `translate(-50%, -50%) scale(${0.8 + 0.2 * Easing.easeOutBack(t1)})`,
        opacity: t1,
      }}>
        <ClowLogo height={220}/>
      </div>

      {/* Tagline + sub */}
      <div style={{
        position: 'absolute',
        left: 0, right: 0, top: '60%',
        textAlign: 'center',
        opacity: t2,
      }}>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 22,
          fontWeight: 600,
          color: PAL.violetLight,
          letterSpacing: '0.3em',
          marginBottom: 18,
        }}>INTELIGÊNCIA INFINITA · POSSIBILIDADES PREMIUM</div>
        <div style={{
          fontFamily: 'Inter',
          fontSize: 32,
          fontWeight: 500,
          color: 'rgba(244,245,251,0.88)',
          letterSpacing: '-0.01em',
        }}>
          3 min de setup · sem fidelidade · reembolso 7 dias
        </div>
      </div>

      {/* Pulse rings around logo */}
      {[1, 2, 3].map(i => {
        const pulse = ((localTime * 0.7 + i * 0.33) % 1);
        const sz = 360 + pulse * 900;
        return (
          <div key={i} style={{
            position: 'absolute',
            left: '50%', top: '42%',
            width: sz, height: sz,
            marginLeft: -sz / 2, marginTop: -sz / 2,
            border: `2px solid ${PAL.violetLight}`,
            borderRadius: '50%',
            opacity: (1 - pulse) * 0.35,
            pointerEvents: 'none',
          }}/>
        );
      })}
    </>
  );
}

Object.assign(window, {
  PAL, ClowLogo, ClowMark, Icon, GridBg, Halo, Particles, Caption, TimestampLabel,
  Scene1, Scene2, Scene3, Scene4, Scene5, Scene6, Scene7, Scene8, Scene9, SceneCTA,
});
