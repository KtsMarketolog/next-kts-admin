'use client';

import { useEffect, useRef, useState } from 'react';
import Container from '@/shared/ui/Container';
import styles from './BrandPortfolio.module.scss';
import { ArrowCircleRightIcon } from '@/shared/icons/ArrowCircleRightIcon';
import { Tecumseh as TecumsehLogo } from '@/shared/icons/Brands/CompressorsIcons/Tecumseh';
import { Wansheng as WanshengLogo } from '@/shared/icons/Brands/CompressorsIcons/Wansheng';
import { Cubigel as CubigelLogo } from '@/shared/icons/Brands/CompressorsIcons/Cubigel';
import { Secop as SecopLogo } from '@/shared/icons/Brands/CompressorsIcons/Secop';
import { Weishans as WeishansLogo } from '@/shared/icons/Brands/CompressorsIcons/Weishans';
import { Invotech as InvotechLogo } from '@/shared/icons/Brands/CompressorsIcons/Invotech';
import { RefComp as RefCompLogo } from '@/shared/icons/Brands/CompressorsIcons/RefComp';
import { Bitzer as BitzerLogo } from '@/shared/icons/Brands/CompressorsIcons/Bitzer';
import { Frascold as FrascoldLogo } from '@/shared/icons/Brands/CompressorsIcons/Frascold';
import { Hispania as HispaniaLogo } from '@/shared/icons/Brands/HeatexchangeIcons/Hispania';
import { Lamel as LamelLogo } from '@/shared/icons/Brands/HeatexchangeIcons/Lamel';
import { Intercold as IntercoldLogo } from '@/shared/icons/Brands/HeatexchangeIcons/Intercold';
import { Onda as OndaLogo } from '@/shared/icons/Brands/HeatexchangeIcons/Onda';
import { Guntner as GuntnerLogo } from '@/shared/icons/Brands/HeatexchangeIcons/Guntner';
import { Sunon as SunonLogo } from '@/shared/icons/Brands/FansIcons/Sunon';
import { FansTech as FansTechLogo } from '@/shared/icons/Brands/FansIcons/FansTech';
import { MaerFanMotor as MaerFanMotorLogo } from '@/shared/icons/Brands/FansIcons/MaerFanMotor';
import { Afl as AflLogo } from '@/shared/icons/Brands/FansIcons/Afl';
import { Weiguang as WeiguangLogo } from '@/shared/icons/Brands/FansIcons/Weiguang';
import { Bayoung as BayoungLogo } from '@/shared/icons/Brands/FansIcons/Bayoung';
import { Dunli as DunliLogo } from '@/shared/icons/Brands/FansIcons/Dunli';
import { Carel as CarelLogo } from '@/shared/icons/Brands/ControllersIcons/Carel';
import { Dixell as DixellLogo } from '@/shared/icons/Brands/ControllersIcons/Dixell';
import { Elitech as ElitechLogo } from '@/shared/icons/Brands/ControllersIcons/Elitech';
import { Shtrol as ShtrolLogo } from '@/shared/icons/Brands/ControllersIcons/Shtrol';
import { Hailiang as HailiangLogo } from '@/shared/icons/Brands/PipesIcons/Hailiang';
import { Icg as IcgLogo } from '@/shared/icons/Brands/PipesIcons/Icg';
import { Gt as GtLogo } from '@/shared/icons/Brands/PipesIcons/Gt';
import { Frigopoint as FrigopointLogo } from '@/shared/icons/Brands/VesselsIcons/Frigopoint';
import { Lefoo as LefooLogo } from '@/shared/icons/Brands/LineIcons/Lefoo';
import { Sanhua as SanhuaLogo } from '@/shared/icons/Brands/LineIcons/Sanhua';
import { SedesGroup as SedesGroupLogo } from '@/shared/icons/Brands/HeatingIcons/SedesGroup';
import { Heatgene as HeatgeneLogo } from '@/shared/icons/Brands/HeatingIcons/Heatgene';

const iconByKey = {
  tecumseh: <TecumsehLogo />,
  wansheng: <WanshengLogo />,
  cubigel: <CubigelLogo />,
  secop: <SecopLogo />,
  weishans: <WeishansLogo />,
  invotech: <InvotechLogo />,
  refcomp: <RefCompLogo />,
  bitzer: <BitzerLogo />,
  frascold: <FrascoldLogo />,
  hispania: <HispaniaLogo />,
  lamel: <LamelLogo />,
  intercold: <IntercoldLogo />,
  onda: <OndaLogo />,
  guntner: <GuntnerLogo />,
  sunon: <SunonLogo />,
  fansTech: <FansTechLogo />,
  maerFanMotor: <MaerFanMotorLogo />,
  afl: <AflLogo />,
  weiguang: <WeiguangLogo />,
  bayoung: <BayoungLogo />,
  dunli: <DunliLogo />,
  carel: <CarelLogo />,
  dixell: <DixellLogo />,
  elitech: <ElitechLogo />,
  shtrol: <ShtrolLogo />,
  hailiang: <HailiangLogo />,
  icg: <IcgLogo />,
  gt: <GtLogo />,
  frigopoint: <FrigopointLogo />,
  lefoo: <LefooLogo />,
  sanhua: <SanhuaLogo />,
  sedesGroup: <SedesGroupLogo />,
  heatgene: <HeatgeneLogo />,
};

export const BrandPortfolio = () => {
  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);
  const [activeTab, setActiveTab] = useState('');
  const [scrollDirection, setScrollDirection] = useState('right');
  const tabsRef = useRef(null);

  useEffect(() => {
    fetch('/api/brand-portfolio', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        const nextCategories = Array.isArray(data.categories) ? data.categories : [];
        setCategories(nextCategories);
        setBrands(Array.isArray(data.brands) ? data.brands : []);
        setActiveTab((current) => current || nextCategories[0]?.key || '');
      })
      .catch(() => {
        setCategories([]);
        setBrands([]);
      });
  }, []);

  const scrollTabs = () => {
    if (!tabsRef.current) return;

    const container = tabsRef.current;
    const scrollAmount = 200;

    if (scrollDirection === 'right') {
      const distanceToEnd = container.scrollWidth - container.clientWidth - container.scrollLeft;
      container.scrollBy({ left: Math.min(distanceToEnd, scrollAmount), behavior: 'smooth' });
      setTimeout(() => {
        if (container.scrollLeft + container.clientWidth >= container.scrollWidth - 2) {
          setScrollDirection('left');
        }
      }, 400);
      return;
    }

    const distanceToStart = container.scrollLeft;
    container.scrollBy({ left: -Math.min(distanceToStart, scrollAmount), behavior: 'smooth' });
    setTimeout(() => {
      if (container.scrollLeft <= 2) {
        setScrollDirection('right');
      }
    }, 400);
  };

  useEffect(() => {
    const container = tabsRef.current;
    if (!container) return undefined;

    const handleScroll = () => {
      if (container.scrollLeft <= 2) {
        setScrollDirection('right');
      } else if (container.scrollLeft + container.clientWidth >= container.scrollWidth - 2) {
        setScrollDirection('left');
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  const activeCategory = categories.find((category) => category.key === activeTab);
  const activeBrands = activeCategory
    ? brands.filter((brand) => brand.categoryId === activeCategory.id)
    : [];

  return (
    <section className={styles.brandPortfolio}>
      <div className={styles.title}>
        Портфель брендов
        <div
          className={styles.titleArrow}
          onClick={scrollTabs}
          style={{
            transform: scrollDirection === 'left' ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.3s ease',
          }}
        >
          <ArrowCircleRightIcon />
        </div>
      </div>

      <div className={styles.tabsWrapper}>
        <div className={styles.tabs} ref={tabsRef}>
          {categories.map((tab) => (
            <button
              key={tab.id}
              className={`${styles.tabButton} ${activeTab === tab.key ? styles.active : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.title}
            </button>
          ))}
        </div>
      </div>

      <Container>
        <div className={styles.grid}>
          {activeBrands.length > 0 ? (
            activeBrands.map((brand) => (
              <div key={brand.id} className={styles.card}>
                {brand.imageUrl ? <img src={brand.imageUrl} alt={brand.name} /> : iconByKey[brand.iconKey] || brand.name}
              </div>
            ))
          ) : (
            <div className={styles.placeholder}>Бренды появятся позже</div>
          )}
        </div>
      </Container>
    </section>
  );
};
