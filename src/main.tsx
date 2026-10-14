import React from "react";
import { createRoot } from "react-dom/client";
import "@kanbus/ui/styles/index.css";
import "@kanbus/ui/styles/kanban.css";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
