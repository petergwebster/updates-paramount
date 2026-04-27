import React, { useState } from 'react'
import { supabase } from '../supabase'
import styles from './LoginScreen.module.css'

export default function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin(e) {
    e.preventDefault()
    if (!email.trim() || !password) return
    setLoading(true)
    setError('')

    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })

    if (authError) {
      setError('Invalid email or password. Please try again.')
      setLoading(false)
      return
    }

    // Fetch profile (full_name + role drive landing logic in App.jsx)
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, role')
      .eq('id', data.user.id)
      .single()

    setLoading(false)
    onLogin(data.user, profile)
  }

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>PP</span>
          <div>
            <h1 className={styles.brandName}>Paramount Prints</h1>
            <p className={styles.brandSub}>Operations Dashboard</p>
          </div>
        </div>

        <div className={styles.divider} />

        <form onSubmit={handleLogin} className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@fsco.com"
              autoFocus
              autoComplete="email"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
          {error && <p className={styles.error}>{error}</p>}
          <button
            type="submit"
            className={`primary ${styles.loginBtn}`}
            disabled={loading || !email || !password}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p className={styles.footer}>F. Schumacher &amp; Co. · Internal use only</p>
      </div>
    </div>
  )
}
