import React from "react";
import { createRoot } from "react-dom/client";
import "../fonts.css";
import "../styles.css";
import "./portal.css";
import { PortalApp } from "./PortalApp";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PortalApp />
  </React.StrictMode>,
);
