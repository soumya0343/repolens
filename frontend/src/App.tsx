import { BrowserRouter, Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import Home from "./pages/Home";
import Setup from "./pages/Setup";
import Overview from "./pages/Overview";
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
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
