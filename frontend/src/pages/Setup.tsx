import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../lib/apiConfig';

interface GithubRepo {
  id: number;
  name: string;
  owner: { login: string };
  private: boolean;
  synced_at?: string;
}

interface ConnectedRepo {
  id: string;
  name: string;
  owner: string;
  synced_at?: string;
}

const Setup: React.FC = () => {
  const [availableRepos, setAvailableRepos] = useState<GithubRepo[]>([]);
  const [connectedRepos, setConnectedRepos] = useState<ConnectedRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/');
      return;
    }

    const fetchRepos = async () => {
      try {
        const headers = { Authorization: `Bearer ${token}` };
        
        // Fetch already connected repos
        const connectedRes = await axios.get(`${API_BASE_URL}/repos/`, { headers });
        setConnectedRepos(connectedRes.data);

        // Fetch available repos from github
        const availableRes = await axios.get(`${API_BASE_URL}/repos/github/available`, { headers });
        setAvailableRepos(availableRes.data);
      } catch (err) {
        console.error('Failed to load repos', err);
      } finally {
        setLoading(false);
      }
    };

    fetchRepos();
  }, [navigate]);

  const findConnectedRepoId = (repo: GithubRepo, list: ConnectedRepo[] = connectedRepos) => {
    const found = list.find(
      (connected) => connected.owner === repo.owner.login && connected.name === repo.name
    );
    return found?.id;
  };

  const handleConnect = async (repo: GithubRepo) => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.post(`${API_BASE_URL}/repos/`, {
        github_id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      // Re-fetch connected repos
      const connectedRes = await axios.get(`${API_BASE_URL}/repos/`, { 
        headers: { Authorization: `Bearer ${token}` } 
      });
      setConnectedRepos(connectedRes.data);

      const newRepoId = response.data?.repo_id || findConnectedRepoId(repo, connectedRes.data);
      if (newRepoId) {
        // Navigate to dashboard to watch progress using the internal repo ID
        navigate('/dashboard', { state: { repoId: newRepoId } });
      }
    } catch (err) {
      console.error('Failed to connect repo', err);
    }
  };

  if (loading) return <div>Loading repositories...</div>;

  return (
    <div className="setup-container">
      <h2>Connect a Repository</h2>
      <p>Select a repository to begin the historical metadata backfill.</p>
      
      <div className="repo-list">
        {availableRepos.map(repo => {
          const connectedRepoId = findConnectedRepoId(repo);
          return (
            <div key={repo.id} className="repo-card">
              <div className="repo-info">
                <h3>{repo.owner.login} / {repo.name}</h3>
                <span className="badge">{repo.private ? "Private" : "Public"}</span>
              </div>
              
              {connectedRepoId ? (
                <button 
                  onClick={() => navigate('/dashboard', { state: { repoId: connectedRepoId } })} 
                  className="connected-btn"
                >
                  View Analysis
                </button>
              ) : (
                <button onClick={() => handleConnect(repo)} className="connect-btn">Connect & Analyze</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Setup;
