import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/dm-sans'
import './index.css'
import App from './App'

Promise.race([document.fonts.load('500 1em "DM Sans Variable"'), new Promise(resolve => setTimeout(resolve, 1000))])
  .finally(() => ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>))
