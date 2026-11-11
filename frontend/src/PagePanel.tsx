import { createContext, useContext, type ReactNode } from 'react'
import './PagePanel.css'

const PageActive = createContext(true)
export const usePageActive = () => useContext(PageActive)

// Visited pages live only as long as their authenticated workspace is mounted.
export function PagePanel({ active, children }: { active: boolean; children: ReactNode }) {
  return <PageActive.Provider value={active}>
    <div className="page-panel" hidden={!active}>{children}</div>
  </PageActive.Provider>
}
