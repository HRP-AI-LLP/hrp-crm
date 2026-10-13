import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { LoginPage, SignupPage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { KnowledgePage } from './pages/Knowledge';
import { PipelinePage } from './pages/Pipeline';
import { PublicFormPage } from './pages/PublicForm';
import { RecordDetailPage } from './pages/RecordDetail';
import { RecordListPage } from './pages/RecordList';
import { SettingsPage } from './pages/Settings';
import { TasksPage } from './pages/Tasks';

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, ready } = useAuth();
  const loc = useLocation();
  if (!ready)
    return (
      <div style={{ padding: 32 }}>
        <Spinner />
      </div>
    );
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export function App() {
  const { me, ready } = useAuth();
  return (
    <Routes>
      <Route path="/f/:key" element={<PublicFormPage />} />
      <Route path="/login" element={ready && me ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="o/:object" element={<RecordListPage />} />
        <Route path="o/:object/:id" element={<RecordDetailPage />} />
        <Route path="pipeline/:object" element={<PipelinePage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
