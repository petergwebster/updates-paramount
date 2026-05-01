import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { isSuperAdmin, SUPER_ADMIN_EMAIL, destinationsFor } from '../lib/access'
import styles from './UserManagement.module.css'

/**
 * UserManagement — admin UI restricted to the super-admin.
 *
 * Features:
 *   - View all users (name, role, active, last sign-in)
 *   - Change a user's role (admin / exec / manager / qa)
 *   - Activate / deactivate users
 *   - Every change is logged to role_change_log for audit trail
 *
 * Guardrails:
 *   - Cannot change own role (would lock yourself out)
 *   - Cannot deactivate self
 *   - Confirmation required on all changes
 *
 * If the current user is NOT the super-admin, this component renders an
 * access-denied message. App.jsx should already gate this; defense in depth.
 *
 * Schema note: the `profiles` table does not have an email column — email
 * lives on auth.users. We identify users here by full_name + the auth-side
 * email shown in the header for the current user only.
 *
 * Props:
 *   authUser — the current auth.users object (has .id, .email)
 */
export default function UserManagement({ authUser }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [savingId, setSavingId] = useState(null)
  const [confirmAction, setConfirmAction] = useState(null)

  const isAllowed = isSuperAdmin(authUser)

  // Load users — gated to super-admin via the conditional inside the effect,
  // not via an early return before the hook (which would violate React's
  // rules-of-hooks if access ever toggles for the same component instance).
  useEffect(() => {
    if (!isAllowed) return
    loadUsers()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAllowed])

  async function loadUsers() {
    setLoading(true)
    setError(null)
    try {
      // No email column on profiles — it lives on auth.users.
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, role, active, created_at')
        .order('full_name', { ascending: true })
      if (error) throw error
      setUsers(data || [])
    } catch (err) {
      setError(err.message || 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }

  async function logChange({ targetUser, oldRole, newRole, oldActive, newActive, changeType, notes }) {
    try {
      await supabase.from('role_change_log').insert({
        changed_by: authUser.id,
        changed_by_email: authUser.email,
        target_user: targetUser.id,
        target_email: null, // not available client-side; auth.users not directly queryable
        old_role: oldRole,
        new_role: newRole,
        old_active: oldActive,
        new_active: newActive,
        change_type: changeType,
        notes: notes || null,
      })
    } catch (err) {
      console.error('Failed to write role_change_log:', err)
    }
  }

  async function handleRoleChange(targetUser, newRole) {
    if (targetUser.id === authUser.id) {
      alert("You can't change your own role from this UI.")
      return
    }
    setConfirmAction({
      type: 'role',
      target: targetUser,
      newValue: newRole,
      message: `Change ${targetUser.full_name || 'this user'}'s role from "${targetUser.role}" to "${newRole}"?`,
    })
  }

  async function handleActiveToggle(targetUser) {
    if (targetUser.id === authUser.id) {
      alert("You can't deactivate yourself.")
      return
    }
    const newActive = !targetUser.active
    setConfirmAction({
      type: 'active',
      target: targetUser,
      newValue: newActive,
      message: newActive
        ? `Reactivate ${targetUser.full_name || 'this user'}? They'll regain access on next login.`
        : `Deactivate ${targetUser.full_name || 'this user'}? They'll lose all destination access immediately.`,
    })
  }

  async function executeConfirmed() {
    if (!confirmAction) return
    const { type, target, newValue } = confirmAction
    setSavingId(target.id)
    setError(null)

    try {
      if (type === 'role') {
        const { error } = await supabase
          .from('profiles')
          .update({ role: newValue })
          .eq('id', target.id)
        if (error) throw error
        await logChange({
          targetUser: target,
          oldRole: target.role,
          newRole: newValue,
          oldActive: target.active,
          newActive: target.active,
          changeType: 'role_change',
        })
      } else if (type === 'active') {
        const { error } = await supabase
          .from('profiles')
          .update({ active: newValue })
          .eq('id', target.id)
        if (error) throw error
        await logChange({
          targetUser: target,
          oldRole: target.role,
          newRole: target.role,
          oldActive: target.active,
          newActive: newValue,
          changeType: newValue ? 'activation' : 'deactivation',
        })
      }
      await loadUsers()
    } catch (err) {
      setError(err.message || 'Update failed')
    } finally {
      setSavingId(null)
      setConfirmAction(null)
    }
  }

  // Render: access denial AFTER hooks, not before.
  if (!isAllowed) {
    return (
      <div className={styles.denied}>
        <div className={styles.deniedTitle}>Restricted</div>
        <div className={styles.deniedBody}>
          User Management is restricted to the super-admin only.
        </div>
      </div>
    )
  }

  if (loading) {
    return <div className={styles.loadingState}>Loading users…</div>
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Admin · Restricted</div>
          <h1 className={styles.title}>User Management</h1>
          <p className={styles.sub}>
            Change roles, activate or deactivate users. Every change is logged.
            You're signed in as <strong>{authUser?.email}</strong>.
          </p>
        </div>
        <div className={styles.summary}>
          <div className={styles.summaryItem}>
            <div className={styles.summaryNum}>{users.length}</div>
            <div className={styles.summaryLabel}>Total users</div>
          </div>
          <div className={styles.summaryItem}>
            <div className={styles.summaryNum}>{users.filter(u => u.active !== false).length}</div>
            <div className={styles.summaryLabel}>Active</div>
          </div>
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <div className={styles.table}>
        <div className={`${styles.row} ${styles.headerRow}`}>
          <div className={styles.cell}>User</div>
          <div className={styles.cell}>Role</div>
          <div className={styles.cell}>Access</div>
          <div className={styles.cell}>Status</div>
          <div className={styles.cell}>Actions</div>
        </div>

        {users.map(u => {
          const isSelf = u.id === authUser.id
          const isSaving = savingId === u.id
          const dests = destinationsFor(u)
          return (
            <div key={u.id} className={`${styles.row} ${u.active === false ? styles.inactive : ''}`}>
              <div className={styles.cell}>
                <div className={styles.userName}>
                  {u.full_name || '(no name)'}
                  {isSelf && <span className={styles.selfBadge}>you</span>}
                </div>
              </div>
              <div className={styles.cell}>
                <select
                  className={styles.roleSelect}
                  value={u.role || ''}
                  onChange={e => handleRoleChange(u, e.target.value)}
                  disabled={isSelf || isSaving}
                  title={isSelf ? "You can't change your own role" : 'Change role'}
                >
                  <option value="admin">admin</option>
                  <option value="exec">exec</option>
                  <option value="manager">manager</option>
                  <option value="qa">qa</option>
                </select>
              </div>
              <div className={styles.cell}>
                <div className={styles.accessChips}>
                  {dests.length === 0 ? (
                    <span className={styles.accessNone}>none</span>
                  ) : (
                    dests.map(d => (
                      <span key={d} className={`${styles.accessChip} ${styles[d]}`}>
                        {d.charAt(0).toUpperCase() + d.slice(1)}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className={styles.cell}>
                <span className={`${styles.statusPill} ${u.active === false ? styles.statusInactive : styles.statusActive}`}>
                  {u.active === false ? 'Inactive' : 'Active'}
                </span>
              </div>
              <div className={styles.cell}>
                <button
                  type="button"
                  className={styles.toggleBtn}
                  onClick={() => handleActiveToggle(u)}
                  disabled={isSelf || isSaving}
                  title={isSelf ? "You can't deactivate yourself" : (u.active === false ? 'Reactivate' : 'Deactivate')}
                >
                  {u.active === false ? 'Reactivate' : 'Deactivate'}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className={styles.footnote}>
        Super-admin: <strong>{SUPER_ADMIN_EMAIL}</strong>. Only this email can access this page.
        Role changes apply on the user's next page load. Audit log lives in <code>role_change_log</code>.
      </div>

      {/* Confirmation modal */}
      {confirmAction && (
        <div className={styles.modalBackdrop} onClick={() => setConfirmAction(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Confirm change</div>
            <div className={styles.modalBody}>{confirmAction.message}</div>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.modalBtn}
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.modalBtn} ${styles.modalBtnPrimary}`}
                onClick={executeConfirmed}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
