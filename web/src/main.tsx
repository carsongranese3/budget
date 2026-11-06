import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { Shell } from "./app";
import { applyTheme, initialTheme } from "./lib";
import Chart from "./pages/Chart";
import Budgets from "./pages/Budgets";
import { Dashboard } from "./pages/Dashboard";
import { Recurring } from "./pages/Recurring";
import Import from "./pages/Import";
import Transactions from "./pages/Transactions";
import Settings from "./pages/Settings";

applyTheme(initialTheme()); // before first paint, avoids a flash

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Dashboard />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="chart" element={<Chart />} />
          <Route path="import" element={<Import />} />
          <Route path="budgets" element={<Budgets />} />
          <Route path="recurring" element={<Recurring />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Dashboard />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
