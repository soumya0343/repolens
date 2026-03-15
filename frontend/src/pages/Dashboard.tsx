import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

const Dashboard: React.FC = () => {
  const [progress, setProgress] = useState<any>({ status: 'Starting backfill...' });
  const location = useLocation();
  const navigate = useNavigate();
  
  // Try to get repoId from navigation state, otherwise we'd fetch the user's active repo
  const repoId = location.state?.repoId;

  useEffect(() => {
    if (!repoId) {
      // In a real app we would load the default selected repo here
      return; 
    }

    const ws = new WebSocket(`ws://localhost:8000/ws/progress/${repoId}`);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setProgress(data);
      
      if (data.status === 'complete') {
        // All workers finished
        ws.close();
      }
    };

    return () => {
      ws.close();
    };
  }, [repoId]);

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>RepoLens Dashboard</h1>
      </header>
      
      <main className="dashboard-content">
        {!repoId ? (
          <div className="empty-state">
            <h2>No Repository Selected</h2>
            <button onClick={() => navigate('/setup')} className="btn">Go to Setup</button>
          </div>
        ) : (
          <div className="progress-card">
            <h2>Initial Backfill Status</h2>
            <div className="progress-block">
              <span className="label">Current Operation:</span> 
              <span className="value">{progress.status}</span>
            </div>
            {progress.details && (
              <div className="progress-block">
                <span className="label">Details:</span> 
                <span className="value">{progress.details}</span>
              </div>
            )}
            
            {progress.status === 'complete' && (
              <div className="success-banner">
                Backfill complete! The analysis engines are now active.
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default Dashboard;
