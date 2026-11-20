import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// The quotes.* subdomains exist only to serve customer quote links (/q/<token>, which is
// handled by the API, not this app). If anyone lands on the CRM there, send them to the website.
if (/^quotes\./i.test(window.location.hostname)) {
  window.location.replace('https://www.' + window.location.hostname.replace(/^quotes\./i, ''));
} else {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
