import { type ComponentType, lazy, type ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage } from './pages/Auth';
import { AccountPage, MfaRequiredGate } from './pages/Account';


/** Pages load on demand: the first paint (sign-in, my day on a phone) stays small. */
const page = <K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));

const DashboardPage = page(() => import('./pages/Dashboard'), 'DashboardPage');
const KnowledgePage = page(() => import('./pages/Knowledge'), 'KnowledgePage');
const PipelinePage = page(() => import('./pages/Pipeline'), 'PipelinePage');
const PublicFormPage = page(() => import('./pages/PublicForm'), 'PublicFormPage');
const RecordDetailPage = page(() => import('./pages/RecordDetail'), 'RecordDetailPage');
const RecordListPage = page(() => import('./pages/RecordList'), 'RecordListPage');
const SettingsPage = page(() => import('./pages/Settings'), 'SettingsPage');
const TasksPage = page(() => import('./pages/Tasks'), 'TasksPage');
const CalendarPage = page(() => import('./pages/Calendar'), 'CalendarPage');
const DashboardsPage = page(() => import('./pages/Dashboards'), 'DashboardsPage');
const ForecastPage = page(() => import('./pages/Forecast'), 'ForecastPage');
const PublicQuotePage = page(() => import('./pages/QuotePages'), 'PublicQuotePage');
const QuotePrintPage = page(() => import('./pages/QuotePages'), 'QuotePrintPage');
const ReportBuilderPage = page(() => import('./pages/Reports'), 'ReportBuilderPage');
const ReportsPage = page(() => import('./pages/Reports'), 'ReportsPage');
const ApprovalsPage = page(() => import('./pages/Approvals'), 'ApprovalsPage');
const DocPrintPage = page(() => import('./pages/DocPrint'), 'DocPrintPage');
const InventoryRoute = page(() => import('./pages/Operations'), 'InventoryRoute');
const BillingRoute = page(() => import('./pages/Operations'), 'BillingRoute');
const JobConfirmPage = page(() => import('./pages/CustomerPages'), 'JobConfirmPage');
const TicketStatusPage = page(() => import('./pages/CustomerPages'), 'TicketStatusPage');
const PaidPage = page(() => import('./pages/CustomerPages'), 'PaidPage');
const FieldSchedulePage = page(() => import('./pages/FieldSchedule'), 'FieldSchedulePage');
const FieldPage = page(() => import('./pages/Field'), 'FieldPage');
const PrivacyPortalPage = page(() => import('./pages/PrivacyPages'), 'PrivacyPortalPage');
const PrivacyVerifyPage = page(() => import('./pages/PrivacyPages'), 'PrivacyVerifyPage');
const PrivacyStatusPage = page(() => import('./pages/PrivacyPages'), 'PrivacyStatusPage');
const UnsubscribePage = page(() => import('./pages/PrivacyPages'), 'UnsubscribePage');

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
    <Suspense
      fallback={
        <div style={{ padding: 32 }}>
          <Spinner />
        </div>
      }
    >
    <Routes>
      <Route path="/f/:key" element={<PublicFormPage />} />
      <Route path="/q/:token" element={<PublicQuotePage />} />
      <Route path="/d/:token" element={<JobConfirmPage kind="shipment" />} />
      <Route path="/i/:token" element={<JobConfirmPage kind="installation" />} />
      <Route path="/t/:token" element={<TicketStatusPage />} />
      <Route path="/paid" element={<PaidPage />} />
      <Route path="/privacy/verify/:token" element={<PrivacyVerifyPage />} />
      <Route path="/privacy/status/:token" element={<PrivacyStatusPage />} />
      <Route path="/privacy/:key" element={<PrivacyPortalPage />} />
      <Route path="/unsubscribe/:token" element={<UnsubscribePage />} />
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
        <Route path="field" element={<FieldPage />} />
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
        <Route path="schedule" element={<FieldSchedulePage />} />
        <Route path="billing" element={<BillingRoute />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
