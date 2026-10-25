import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HostPage } from './Host.js';
import { Landing } from './Landing.js';
import { PlayerPage } from './Player.js';
import { ProjectorPage } from './Projector.js';
import './styles.css';

function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

function App() {
  const path = usePath();
  const m = path.match(/^\/(play|host|screen)\/([A-Za-z0-9]+)/);
  if (m) {
    const code = m[2].toUpperCase();
    if (m[1] === 'play') return <PlayerPage key={code} code={code} />;
    if (m[1] === 'host') return <HostPage key={code} code={code} />;
    return <ProjectorPage key={code} code={code} />;
  }
  return <Landing />;
}

createRoot(document.getElementById('root')!).render(<App />);
