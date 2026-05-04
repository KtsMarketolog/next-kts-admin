"use client";

import React from "react";
import dynamic from "next/dynamic";

import styles from "./MainPromo.module.scss";

const Popup = dynamic(() => import("@/shared/ui/Popup/Popup"), { ssr: false });

export type MainPromoPopupState = {
  ariaLabel: string;
  scrollContent: boolean;
  content: React.ReactNode;
} | null;

type MainPromoPopupProps = {
  popup: MainPromoPopupState;
  onClose: () => void;
};

export function MainPromoPopup({ popup, onClose }: MainPromoPopupProps) {
  if (!popup) return null;

  return (
    <div className={styles.promoPopup}>
      <Popup open onClose={onClose} ariaLabel={popup.ariaLabel} scrollContent={popup.scrollContent}>
        {popup.content}
      </Popup>
    </div>
  );
}
