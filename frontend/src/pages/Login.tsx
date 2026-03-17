import React from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/apiConfig';

const Login: React.FC = () => {
  const handleLogin = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/auth/github/`);
      if (response.data.redirect_url) {
        window.location.href = response.data.redirect_url;
      }
    } catch (error) {
      console.error('Login failed', error);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h1>RepoLens</h1>
        <p>GitHub-Native SDLC Intelligence Platform</p>
        <button className="github-btn" onClick={handleLogin}>
          Sign in with GitHub
        </button>
      </div>
    </div>
  );
};

export default Login;
