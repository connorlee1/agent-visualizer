import { Navigate, Route, Routes, useParams } from 'react-router';
import { AppShell } from './components/shell/AppShell';
import { HomePage } from './routes/HomePage';
import { GridPage } from './routes/GridPage';
import { AgentPage } from './routes/AgentPage';
import { HistoryPage } from './routes/HistoryPage';
import { SessionPage } from './routes/SessionPage';

function ProjectRedirect() {
  const { projectId } = useParams();
  return <Navigate to={`/history/${projectId}`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/grid" element={<GridPage />} />
        <Route path="/agents/:tmuxName" element={<AgentPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/history/:projectId" element={<HistoryPage />} />
        <Route path="/s/:provider/:sessionId" element={<SessionPage />} />
        {/* old URLs */}
        <Route path="/projects" element={<Navigate to="/history" replace />} />
        <Route path="/projects/:projectId" element={<ProjectRedirect />} />
      </Route>
    </Routes>
  );
}
