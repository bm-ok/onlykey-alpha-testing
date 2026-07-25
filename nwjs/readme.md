# NW.js SDK AI Debugging Environment

A desktop application boilerplate built with **NW.js (SDK Flavor)** and configured for automated debugging, inspection, and interaction workflows with AI assistants like Claude.

---

## Features

* **NW.js SDK Flavor**: Provides built-in developer tools, full Node.js integration, and Chrome DevTools Protocol (CDP) support.
* **Isolated User Profile**: Automatically manages a local user data directory to prevent session locks and browser profile conflicts.
* **Automation Ready**: Structured for remote debugging ports to let external scripts and agents inspect, monitor, and interact with the application runtime.

---

## Project Structure

```text
nwjs/
├── index.html       # Frontend UI entry point
├── package.json     # Project configuration and scripts
└── udata/           # Isolated user data directory (auto-generated)
```