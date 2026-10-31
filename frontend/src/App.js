import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "@/App.css";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import Dashboard from "@/pages/Dashboard";
import RoomEditor from "@/pages/RoomEditor";
import KnowledgeBase from "@/pages/KnowledgeBase";
import DerogationReport from "@/pages/DerogationReport";
import ComponentsLibrary from "@/pages/ComponentsLibrary";
import Templates from "@/pages/Templates";
import FloorAnalysis from "@/pages/FloorAnalysis";
import RulesMap from "@/pages/RulesMap";
import RequestAccess from "@/pages/RequestAccess";
import Landing from "@/pages/Landing";
import AcceptInvite from "@/pages/AcceptInvite";
import TermsModal, { TERMS_VERSION } from "@/components/legal/TermsModal";
import TourController from "@/components/tour/TourController";
import { Toaster } from "@/components/ui/sonner";

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAFAFB]">
      <div className="font-mono text-xs uppercase tracking-[0.3em] text-slate-400">Loading…</div>
    </div>
  );
}

function Protected({ children }) {
  const { user, checked, logout } = useAuth();
  // A user has passed the current Terms gate if EITHER:
  //   (a) their user record on the server has `tos_accepted_version === TERMS_VERSION`
  //       (survives across devices / browsers), OR
  //   (b) localStorage on this browser has that version (survives cookie clears).
  // We defer showing the modal until we know the answer so returning users
  // don't see a flash of the ToS overlay.
  const [tosPassed, setTosPassed] = React.useState(null);
  React.useEffect(() => {
    if (!checked || !user) return;
    let passed = false;
    if (user?.tos_accepted_version === TERMS_VERSION) passed = true;
    else {
      try { passed = localStorage.getItem("his:tos_accepted_version") === TERMS_VERSION; }
      catch {}
    }
    setTosPassed(passed);
    if (passed) {
      // Sync localStorage from the server so subsequent mounts skip the effect.
      try { localStorage.setItem("his:tos_accepted_version", TERMS_VERSION); } catch {}
    }
  }, [user, checked]);
  if (!checked || user === null) return <LoadingScreen />;
  if (!user) return <Navigate to="/signin" replace />;
  return (
    <>
      {children}
      {tosPassed === false && (
        <TermsModal
          user={user}
          onAccepted={() => setTosPassed(true)}
          onDecline={() => {
            try { localStorage.removeItem("his:tos_accepted_version"); } catch {}
            logout && logout();
          }}
        />
      )}
    </>
  );
}

function EntryPoint() {
  // Default landing after sign-in: Estate dashboard.
  return <Navigate to="/dashboard" replace />;
}

function AppRouter() {
  const { user, checked } = useAuth();
  return (
    <Routes>
      <Route path="/signin" element={
        !checked ? <LoadingScreen /> : user ? <Navigate to="/" replace /> : <Landing />
      } />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/" element={<Protected><EntryPoint /></Protected>} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/room/:roomId" element={<Protected><RoomEditor /></Protected>} />
      <Route path="/floor/:floorId" element={<Protected><FloorAnalysis /></Protected>} />
      <Route path="/rules-map" element={<Protected><RulesMap /></Protected>} />
      <Route path="/knowledge" element={<Protected><KnowledgeBase /></Protected>} />
      <Route path="/ingestion" element={<Navigate to="/knowledge?tab=contribute" replace />} />
      <Route path="/derogations" element={<Navigate to="/knowledge?tab=derogations" replace />} />
      <Route path="/derogations/report" element={<Protected><DerogationReport /></Protected>} />
      <Route path="/components" element={<Protected><ComponentsLibrary /></Protected>} />
      <Route path="/families" element={<Protected><ComponentsLibrary /></Protected>} />
      <Route path="/templates" element={<Protected><Templates /></Protected>} />
      <Route path="/room/:roomId/request-access" element={<Protected><RequestAccess /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * Route-aware helper that renders the global product tour ONLY for
 * signed-in users. Mounted inside <BrowserRouter> so it can use
 * `useNavigate` to walk the user across pages.
 */
function GlobalTour() {
  const { user, checked } = useAuth();
  if (!checked || !user) return null;
  return <TourController />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="App">
          <Toaster position="bottom-right" />
          <AppRouter />
          <GlobalTour />
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}
