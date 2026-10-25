// How a Settings page sends the dialog to another page. Its own module, not settings-panels':
// what the main bundle draws (the Add menu's HiveHub rows) shares pages' parts that use it, and
// importing it from there would pull the lazy Settings chunk into the main bundle.
import { createContext, useContext } from "react";

export const SettingsNavigate = createContext<(id: string) => void>(() => {});
export const useSettingsNavigate = (): ((id: string) => void) => useContext(SettingsNavigate);
