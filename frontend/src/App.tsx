import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { AppLayout } from "./components/layout/AppLayout";
import { Toaster } from "./components/ui/toaster";
import { useAuthStore } from "./store/auth";
import { Dashboard } from "./pages/Dashboard";
import { NotFound } from "./pages/NotFound";

const Analytics = lazy(() => import("./pages/Analytics").then((m) => ({ default: m.Analytics })));
const UsageLogs = lazy(() => import("./pages/UsageLogs").then((m) => ({ default: m.UsageLogs })));
const Channels = lazy(() => import("./pages/Channels").then((m) => ({ default: m.Channels })));
const Tokens = lazy(() => import("./pages/Tokens").then((m) => ({ default: m.Tokens })));
const Pricing = lazy(() => import("./pages/Pricing").then((m) => ({ default: m.Pricing })));
const ApiTest = lazy(() => import("./pages/ApiTest").then((m) => ({ default: m.ApiTest })));
const SystemSettings = lazy(() => import("./pages/SystemSettings").then((m) => ({ default: m.SystemSettings })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return null;
  }

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function HomeRoute() {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return null;
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Dashboard />;
}

function App() {
  const { checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <AppLayout>
          <Suspense
            fallback={
              <div className="flex justify-center py-24">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<HomeRoute />} />
              <Route path="/analytics" element={<Navigate to="/dashboard" replace />} />
              <Route
                path="/api-test"
                element={
                  <ProtectedRoute>
                    <ApiTest />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <Analytics />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/usage-logs"
                element={
                  <ProtectedRoute>
                    <UsageLogs />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/channels"
                element={
                  <ProtectedRoute>
                    <Channels />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/channels/new"
                element={
                  <ProtectedRoute>
                    <Channels createMode />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/channels/edit/:key"
                element={
                  <ProtectedRoute>
                    <Channels editRoute />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tokens"
                element={
                  <ProtectedRoute>
                    <Tokens />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tokens/new"
                element={
                  <ProtectedRoute>
                    <Tokens createMode />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tokens/edit/:key"
                element={
                  <ProtectedRoute>
                    <Tokens editRoute />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/pricing"
                element={
                  <ProtectedRoute>
                    <Pricing />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/settings"
                element={
                  <ProtectedRoute>
                    <SystemSettings />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </AppLayout>
        <Toaster />
      </Router>
    </QueryClientProvider>
  );
}

export default App;
