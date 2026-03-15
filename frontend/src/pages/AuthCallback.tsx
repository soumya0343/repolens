import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';

const AuthCallback: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    
    if (code) {
      // Exchange code for token
      axios.get(`http://localhost:8000/auth/github/callback?code=${code}`)
        .then(response => {
          if (response.data.status === 'success') {
            // Ideally store JWT in local storage here
            // localStorage.setItem('token', response.data.token);
            navigate('/dashboard');
          } else {
            setError('Authentication failed. Please try again.');
          }
        })
        .catch(err => {
           console.error(err);
           setError('An error occurred during authentication.');
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
