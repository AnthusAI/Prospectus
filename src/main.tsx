import React from "react";
import { createRoot } from "react-dom/client";
import "@kanbus/ui/styles/index.css";
import "@kanbus/ui/styles/kanban.css";
import "@kanbus/ui/styles/organizer.css";
import "./fonts.css";
import "./styles.css";
import { App } from "./App";

const root = createRoot(document.getElementById("root")!);
if (
  (import.meta.env.DEV ||
    import.meta.env.MODE === "synthetic-review" ||
    Boolean(import.meta.env.VITE_INTAKE_EVALUATION_URL)) &&
  window.location.pathname === "/request-demo"
) {
  void import("./IntakeForm").then(({ IntakeForm }) => root.render(<IntakeForm />));
} else root.render(<App />);
