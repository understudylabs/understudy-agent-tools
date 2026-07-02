import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import Component from '/Users/luis/Developer/understudy/understudy-agent-tools/understudy-agent-tools-mcp-app/resources/skill-catalog/widget.tsx'

const container = document.getElementById('widget-root')
if (container && Component) {
  const root = createRoot(container)
  root.render(<Component />)
}
