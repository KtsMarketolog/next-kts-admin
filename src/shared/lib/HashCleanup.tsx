"use client";
import { useEffect } from "react";

export default function HashCleanup() {

  useEffect(() => {

    if (window.location.hash) {

      const id = setTimeout(() => {

        history.replaceState(null, "", window.location.pathname);

      }, 800);

      return () => clearTimeout(id);

    }

  }, []);

  return null;

}