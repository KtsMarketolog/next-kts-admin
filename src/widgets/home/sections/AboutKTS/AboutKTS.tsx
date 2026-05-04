"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Container from '@/shared/ui/Container';
import { ArrowHorizontal } from '@/shared/icons/ArrowHorizontal';
import { ArrowVertical } from '@/shared/icons/ArrowVertical';
import { IconArrows } from '@/shared/icons/IconArrows';
import { IconCircles } from '@/shared/icons/IconCircles';
import { IconCrystal } from '@/shared/icons/IconCrystal';
import { IconPathNet } from '@/shared/icons/IconPathNet';
import styles from "./AboutKTS.module.scss";

type FactConfig = {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement> & { className?: string }>;
  number: string;
  description: string[];
};

const FACTS: FactConfig[] = [
  {
    icon: IconCircles,
    number: "60 000 м²",
    description: ["складские", "мощности"],
  },
  {
    icon: IconCrystal,
    number: "более 40",
    description: ["брендов", "в портфеле"],
  },
  {
    icon: IconArrows,
    number: "2 000+",
    description: ["видов товаров", "в наличии"],
  },
];

export const AboutKTS = () => {
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const revealedRef = useRef(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const node = sectionRef.current;
    if (!node) {
      return;
    }

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion || !("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }

    const rect = node.getBoundingClientRect();
    const onScreen = rect.top < window.innerHeight && rect.bottom > 0;

    if (!onScreen) {
      setVisible(false);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.target !== node) {
            return;
          }

          if (entry.isIntersecting) {
            revealedRef.current = true;
            setVisible(true);
            observer.unobserve(entry.target);
          } else if (!revealedRef.current) {
            setVisible(false);
          }
        });
      },
      { threshold: 0.2 }
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  return (
    <section className={styles.aboutKts} ref={sectionRef}>
      <Container>
        <h2>КТС – ЭТО</h2>
        <div className={styles.grid}>
          <div className={`${styles.bigCard} ${visible ? styles.visible : ""}`}>
            <div className={styles.title}>
              Всё для <br />
              холода -
              <br />
              в наличии
            </div>
            <ArrowHorizontal className={styles.arrowHorizontal} aria-hidden />
            <ArrowVertical className={styles.arrowVertical} aria-hidden />
            <IconPathNet className={styles.net} aria-hidden />
          </div>

          <div className={styles.facts}>
            {FACTS.map(({ icon: Icon, number, description }, index) => (
              <div
                key={number}
                className={`${styles.fact} ${
                  visible ? styles[`factVisible${index + 1}`] : ""
                }`}
              >
                <Icon className={styles.icon} aria-hidden />
                <span className={styles.number}>{number}</span>
                <span className={styles.desc}>
                  {description.map((line, lineIdx) => (
                    <Fragment key={`${number}-line-${lineIdx}`}>
                      {line}
                      {lineIdx < description.length - 1 && <br />}
                    </Fragment>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
};
