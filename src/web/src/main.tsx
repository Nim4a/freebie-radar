import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installAuthFetch } from "./lib/auth.ts";
import "./styles.css";

// Every request automatically carries the admin password (if logged in)
installAuthFetch();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
