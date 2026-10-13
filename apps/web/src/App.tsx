import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage } from './pages/Auth';
import { AccountPage, MfaRequiredGate } from './pages/Account';
import { DashboardPage } from './pages/Dashboard';
import { KnowledgePage } from './pages/Knowledge';
import { PipelinePage } from './pages/Pipeline';
import { PublicFormPage } from './pages/PublicForm';
import { RecordDetailPage } from './pages/RecordDetail';
import { RecordListPage } from './pages/RecordList';
import { SettingsPage } from './pages/Settings';
import { TasksPage } from './pages/Tasks';
import { CalendarPage } from './pages/Calendar';
import { DashboardsPage } from './pages/Dashboards';
import { ForecastPage } from './pages/Forecast';
import { PublicQuotePage, QuotePrintPage } from './pages/QuotePages';
import { ReportBuilderPage, ReportsPage } from './pages/Reports';
import { ApprovalsPage } from './pages/Approvals';
import { DocPrintPage } from './pages/DocPrint';
import { InventoryRoute } from './pages/Operations';

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
  if (me.security?.mfaRequired && !me.security.mfaEnabled) return <MfaRequiredGate />;
  return <>{children}</>;
}

export function App() {
  const { me, ready } = useAuth();
  return (
    <Routes>
      <Route path="/f/:key" element={<PublicFormPage />} />
      <Route path="/q/:token" element={<PublicQuotePage />} />
      <Route
        path="/print/quote/:id"
        element={
          <RequireAuth>
            <QuotePrintPage />
          </RequireAuth>
        }
      />
      <Route
        path="/print/:kind/:id"
        element={
          <RequireAuth>
            <DocPrintPage />
          </RequireAuth>
        }
      />
      <Route path="/login" element={ready && me ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
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
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="forecast" element={<ForecastPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="reports/:id" element={<ReportBuilderPage />} />
        <Route path="dashboards" element={<DashboardsPage />} />
        <Route path="dashboards/:id" element={<DashboardsPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="inventory" element={<InventoryRoute />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
