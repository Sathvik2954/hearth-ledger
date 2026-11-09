import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { HomeDashboard } from '../components/HomeDashboard'
import { WelcomeScreen } from '../components/WelcomeScreen'
import { loadSavedHome, type SavedHome, saveHome } from '../lib/storage'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  const [home, setHome] = useState<SavedHome | null>(loadSavedHome)

  function select(next: SavedHome | null) {
    saveHome(next)
    setHome(next)
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand__mark" aria-hidden="true">
            H
          </span>
          HearthLedger
        </span>
      </header>
      {home ? (
        // Keyed by id: switching homes remounts the dashboard, dropping all state and
        // aborting the previous home's requests.
        <HomeDashboard key={home.id} home={home} onSwitchHome={() => select(null)} />
      ) : (
        <WelcomeScreen onSelect={select} />
      )}
    </div>
  )
}
