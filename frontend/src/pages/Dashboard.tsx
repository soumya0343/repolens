import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { API_BASE_URL, WS_BASE_URL } from '../lib/apiConfig';

interface RepoData {
  id: string;
  name: string;
  owner: string;
  synced_at: string;
  stats?: {
    commits: number;
    pull_requests: number;
  };
}

interface FileData {
  path: string;
  language: string;
  lines: number;
  risk_score: number;
  violations: string[];
}

const Dashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'overview' | 'files'>('overview');
  const [repoData, setRepoData] = useState<RepoData | null>(null);
  const [filesData, setFilesData] = useState<FileData[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<any>({ status: 'Starting backfill...' });
  const [triggeringBackfill, setTriggeringBackfill] = useState(false);
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  const repoId = location.state?.repoId;

  useEffect(() => {
    if (!repoId) {
      setLoading(false);
      return;
    }

    // Load repository data
    loadRepoData();

    // Set up WebSocket for progress updates
    const ws = new WebSocket(`${WS_BASE_URL}/ws/progress/${repoId}`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setProgress(data);

      if (data.status === 'complete') {
        ws.close();
        // Reload data when backfill is complete
        loadRepoData();
      }
    };

    return () => {
      ws.close();
    };
  }, [repoId]);

  const loadRepoData = async () => {
    if (!repoId) return;

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login');
        return;
      }

      // Load repo details
      const repoResponse = await fetch(`${API_BASE_URL}/repos/${repoId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (repoResponse.ok) {
        const repo = await repoResponse.json();
        setRepoData(repo);
      }

      // Load files data
      const filesResponse = await fetch(`${API_BASE_URL}/repos/${repoId}/files`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (filesResponse.ok) {
        const files = await filesResponse.json();
        setFilesData(files);
      }
    } catch (error) {
      console.error('Error loading repo data:', error);
    } finally {
      setLoading(false);
    }
  };

  const triggerBackfill = async () => {
    if (!repoId) return;
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }

    setTriggeringBackfill(true);
    setBackfillMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/repos/${repoId}/backfill`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.detail || 'Failed to trigger backfill');
      }

      setProgress({
        status: 'Starting backfill...',
        details: 'Manual trigger queued'
      });
      setBackfillMessage('Backfill queued. Watch progress updates.');
    } catch (error: any) {
      console.error('Backfill trigger failed', error);
      setBackfillMessage(error?.message || 'Failed to trigger backfill');
    } finally {
      setTriggeringBackfill(false);
    }
  };

  const getRiskColor = (score: number) => {
    if (score >= 75) return 'text-red-600';
    if (score >= 50) return 'text-yellow-600';
    return 'text-green-600';
  };

  const getRiskBadge = (score: number) => {
    if (score >= 75) return 'bg-red-100 text-red-800';
    if (score >= 50) return 'bg-yellow-100 text-yellow-800';
    return 'bg-green-100 text-green-800';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">RepoLens Dashboard</h1>
              {repoData && (
                <p className="text-sm text-gray-600">
                  {repoData.owner}/{repoData.name}
                </p>
              )}
            </div>
            <button
              onClick={() => navigate('/setup')}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Switch Repository
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Tab Navigation */}
        <div className="border-b border-gray-200 mb-8">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('overview')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'overview'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab('files')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'files'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Files
            </button>
          </nav>
        </div>

        {/* Content */}
        {activeTab === 'overview' && (
          <div className="space-y-8">
            {/* Repository Stats */}
            {repoData && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-white overflow-hidden shadow rounded-lg">
                  <div className="p-5">
                    <div className="flex items-center">
                      <div className="flex-shrink-0">
                        <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      </div>
                      <div className="ml-5 w-0 flex-1">
                        <dl>
                          <dt className="text-sm font-medium text-gray-500 truncate">Total Commits</dt>
                          <dd className="text-lg font-medium text-gray-900">{repoData.stats?.commits || 0}</dd>
                        </dl>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-white overflow-hidden shadow rounded-lg">
                  <div className="p-5">
                    <div className="flex items-center">
                      <div className="flex-shrink-0">
                        <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                      <div className="ml-5 w-0 flex-1">
                        <dl>
                          <dt className="text-sm font-medium text-gray-500 truncate">Pull Requests</dt>
                          <dd className="text-lg font-medium text-gray-900">{repoData.stats?.pull_requests || 0}</dd>
                        </dl>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-white overflow-hidden shadow rounded-lg">
                  <div className="p-5">
                    <div className="flex items-center">
                      <div className="flex-shrink-0">
                        <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <div className="ml-5 w-0 flex-1">
                        <dl>
                          <dt className="text-sm font-medium text-gray-500 truncate">Last Synced</dt>
                          <dd className="text-lg font-medium text-gray-900">
                            {repoData.synced_at ? new Date(repoData.synced_at).toLocaleDateString() : 'Never'}
                          </dd>
                        </dl>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Backfill Progress */}
            {repoId && progress.status !== 'complete' && (
              <div className="bg-white shadow rounded-lg">
                <div className="px-4 py-5 sm:p-6">
                  <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">Initial Backfill Progress</h3>
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-sm font-medium text-gray-700">Status:</span>
                      <span className="text-sm text-gray-900">{progress.status}</span>
                    </div>
                    {progress.details && (
                      <div className="flex justify-between">
                        <span className="text-sm font-medium text-gray-700">Details:</span>
                        <span className="text-sm text-gray-900">{progress.details}</span>
                      </div>
                    )}
                    <div className="mt-4 flex flex-col gap-2">
                      <button
                        onClick={triggerBackfill}
                        disabled={triggeringBackfill}
                        className="inline-flex items-center justify-center rounded-md border border-transparent bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {triggeringBackfill ? 'Triggering backfill…' : 'Trigger backfill'}
                      </button>
                      {backfillMessage && (
                        <p className="text-xs text-gray-500">{backfillMessage}</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Risk Summary */}
            <div className="bg-white shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">Risk Summary</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-red-600">
                      {filesData.filter(f => f.risk_score >= 75).length}
                    </div>
                    <div className="text-sm text-gray-600">High Risk Files</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-yellow-600">
                      {filesData.filter(f => f.risk_score >= 50 && f.risk_score < 75).length}
                    </div>
                    <div className="text-sm text-gray-600">Medium Risk Files</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-600">
                      {filesData.filter(f => f.risk_score < 50).length}
                    </div>
                    <div className="text-sm text-gray-600">Low Risk Files</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'files' && (
          <div className="bg-white shadow overflow-hidden sm:rounded-md">
            <ul className="divide-y divide-gray-200">
              {filesData.map((file, index) => (
                <li key={index} className="px-6 py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center">
                        <p className="text-sm font-medium text-gray-900 truncate">{file.path}</p>
                        <span className={`ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRiskBadge(file.risk_score)}`}>
                          Risk: {file.risk_score}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center text-sm text-gray-500">
                        <span className="capitalize">{file.language}</span>
                        <span className="mx-2">•</span>
                        <span>{file.lines} lines</span>
                        {file.violations.length > 0 && (
                          <>
                            <span className="mx-2">•</span>
                            <span className="text-red-600">{file.violations.length} violations</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex-shrink-0">
                      <div className={`text-lg font-semibold ${getRiskColor(file.risk_score)}`}>
                        {file.risk_score}/100
                      </div>
                    </div>
                  </div>
                  {file.violations.length > 0 && (
                    <div className="mt-2">
                      <ul className="text-sm text-red-600">
                        {file.violations.map((violation, vIndex) => (
                          <li key={vIndex} className="flex items-center">
                            <span className="w-2 h-2 bg-red-600 rounded-full mr-2"></span>
                            {violation}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {filesData.length === 0 && (
              <div className="text-center py-12">
                <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <h3 className="mt-2 text-sm font-medium text-gray-900">No files analyzed</h3>
                <p className="mt-1 text-sm text-gray-500">Files will appear here after the initial backfill completes.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
