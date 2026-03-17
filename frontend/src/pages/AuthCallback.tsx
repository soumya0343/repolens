import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../lib/apiConfig';

const AuthCallback: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    
    if (code) {
      // Exchange code for token
      axios.get(`${API_BASE_URL}/auth/github/callback?code=${code}`)
        .then(response => {
          if (response.data.status === 'success') {
            // Store JWT in local storage here
            localStorage.setItem('token', response.data.token);
            navigate('/setup');
          } else {
            setError(
              response.data.detail ||
              'Authentication failed. Please try again.'
            );
          }
        })
        .catch(err => {
           console.error('Auth callback error', err);
           const detail =
             err?.response?.data?.detail ||
             err?.message ||
             'An error occurred during authentication.';
           setError(detail);
        });
    } else {
      setError('No authorization code found.');
    }
  }, [searchParams, navigate]);

  return (
    <div className="auth-callback">
      {error ? (
        <div className="error">
          <p>{error}</p>
          <button onClick={() => navigate('/')}>Back to Login</button>
        </div>
      ) : (
        <p>Authenticating with GitHub...</p>
      )}
    </div>
  );
};

export default AuthCallback;
