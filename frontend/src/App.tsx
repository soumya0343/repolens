import { BrowserRouter, Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Home from "./pages/Home";
import Setup from "./pages/Setup";
import Overview from "./pages/Overview";
import Files from "./pages/Files";
import PullRequests from "./pages/PullRequests";
import Coupling from "./pages/Coupling";
import CITests from "./pages/CITests";
import AIAssistant from "./pages/AIAssistant";
import Team from "./pages/Team";
import Dashboard from "./pages/Dashboard";
import AuthCallback from "./pages/AuthCallback";
import "./App.css";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/home" element={<Home />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/repo/:repoId" element={<Overview />} />
        <Route path="/repo/:repoId/overview" element={<Overview />} />
        <Route path="/repo/:repoId/files" element={<Files />} />
        <Route path="/repo/:repoId/prs" element={<PullRequests />} />
        <Route path="/repo/:repoId/coupling" element={<Coupling />} />
        <Route path="/repo/:repoId/ci" element={<CITests />} />
        <Route path="/repo/:repoId/ai" element={<AIAssistant />} />
        <Route path="/repo/:repoId/team" element={<Team />} />
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
