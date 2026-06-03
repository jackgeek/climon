import { useEffect, useState } from "react";
import { makeStyles, mergeClasses } from "@fluentui/react-components";

const HOLD_MS = 4000;
const FADE_MS = 600;

const useStyles = makeStyles({
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    backgroundColor: "#000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: 1,
    transition: `opacity ${FADE_MS}ms ease`
  },
  hidden: {
    opacity: 0
  },
  logo: {
    maxWidth: "60%",
    maxHeight: "60%",
    objectFit: "contain"
  }
});

/**
 * Full-screen black intro shown on every page load: holds the logo for HOLD_MS,
 * fades to black over FADE_MS, then calls `onDone` so the host can unmount it
 * and reveal the dashboard.
 */
export function SplashScreen({ onDone }: { onDone: () => void }) {
  const styles = useStyles();
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFading(true), HOLD_MS);
    const doneTimer = setTimeout(onDone, HOLD_MS + FADE_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
    };
  }, [onDone]);

  return (
    <div className={mergeClasses(styles.overlay, fading && styles.hidden)} aria-hidden>
      <img className={styles.logo} src="/assets/logo.jpg" alt="climon" />
    </div>
  );
}
