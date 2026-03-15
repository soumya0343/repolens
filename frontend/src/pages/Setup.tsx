import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

interface Repo {
  id: number;
  name: string;
  owner: { login: string };
  private: boolean;
  synced_at?: string;
}

const Setup: React.FC = () => {
  const [availableRepos, setAvailableRepos] = useState<Repo[]>([]);
  const [connectedRepos, setConnectedRepos] = useState<Repo[]>([]);
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
        const connectedRes = await axios.get('http://localhost:8000/repos/', { headers });
        setConnectedRepos(connectedRes.data);

        // Fetch available repos from github
        const availableRes = await axios.get('http://localhost:8000/repos/github/available', { headers });
        setAvailableRepos(availableRes.data);
      } catch (err) {
        console.error('Failed to load repos', err);
      } finally {
        setLoading(false);
      }
    };

    fetchRepos();
  }, [navigate]);

  const handleConnect = async (repo: Repo) => {
    try {
      const token = localStorage.getItem('token');
      await axios.post('http://localhost:8000/repos/', {
        github_id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      // Re-fetch connected repos
      const connectedRes = await axios.get('http://localhost:8000/repos/', { 
        headers: { Authorization: `Bearer ${token}` } 
      });
      setConnectedRepos(connectedRes.data);
      
      // Navigate to dashboard to watch progress
      navigate('/dashboard', { state: { repoId: repo.id } });
    } catch (err) {
      console.error('Failed to connect repo', err);
    }
  };

  const isConnected = (repoId: number) => {
    return connectedRepos.some(r => r.id.toString() === repoId.toString() || r.name === availableRepos.find(a => a.id === repoId)?.name);
  };

  if (loading) return <div>Loading repositories...</div>;

  return (
    <div className="setup-container">
      <h2>Connect a Repository</h2>
      <p>Select a repository to begin the historical metadata backfill.</p>
      
      <div className="repo-list">
        {availableRepos.map(repo => (
          <div key={repo.id} className="repo-card">
            <div className="repo-info">
              <h3>{repo.owner.login} / {repo.name}</h3>
              <span className="badge">{repo.private ? "Private" : "Public"}</span>
            </div>
            
            {isConnected(repo.id) ? (
              <button disabled className="connected-btn">Connected</button>
            ) : (
              <button onClick={() => handleConnect(repo)} className="connect-btn">Connect & Analyze</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default Setup;
