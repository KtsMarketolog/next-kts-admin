import Container from '@/shared/ui/Container/index';
import styles from './TechSolutions.module.scss';

// сюда подставь свои SVG-иконки (как React-компоненты)
// import { UiIcon } from '@/shared/icons/TechSolutions/UiIcon';
// import { ControllerIcon } from '@/shared/icons/TechSolutions/ControllerIcon';
// import { NetworkIcon } from '@/shared/icons/TechSolutions/NetworkIcon';

type FeatureCard = {

  title: string;
  text: string;
  iconSrc: string;

};

const interfaceCards: FeatureCard[] = [

  {

    title: 'Пользовательский интерфейс',
    text: 'Современная сенсорная панель с интуитивной графикой для полного контроля параметров и удобной настройки',
    iconSrc: '/img/klimatika/tech-solutions/icon/ui.png',

  },

  {

    title: 'Контроллер управления',
    text: 'Мощный российский контроллер, обеспечивающий полное соответствие местным стандартам и требованиям',
    iconSrc: '/img/klimatika/tech-solutions/icon/controller.png',

  },

  {

    title: 'Сетевые интерфейсы',
    text: 'Поддержка основных промышленных протоколов (Modbus RTU/TCP, BACnet) для беспроблемной интеграции в любую систему автоматизации',
    iconSrc: '/img/klimatika/tech-solutions/icon/network.png',

  },
  
];

export const TechSolutions = () => {
  
  return (

    <section className={styles.techSolutions}>

        <h2 className={styles.title}>Технологические решения</h2>

        {/* Верхний блок (эргономичный корпус) */}
        <div className={styles.topCard}>

          <div className={styles.topCardText}>

            <h3 className={styles.topCardTitle}>Эргономичный корпус</h3>

            <p className={styles.topCardDesc}>

              Модульная конструкция, позволяющая осуществлять быструю замену цилиндра и ключевых компонентов без инструмента

            </p>

          </div>

          {/* картинка справа */}
          <div className={styles.topCardMedia}>

            <img src="/img/klimatika/tech-solutions/device-top-card.png" alt="" />

          </div>

        </div>

        {/* Интерфейсы (3 карточки) */}
        <div className={styles.interfaces}>

          <div className={styles.interfacesTrack} role="list">

            {interfaceCards.map((card) => (

              <article

                className={styles.interfaceCard}
                key={card.title}
                role="listitem"

              >

                <img

                  className={styles.interfaceIcon}
                  src={card.iconSrc}
                  alt=""
                  aria-hidden="true"

                />

                <div className={styles.interfaceContent}>

                  <h4 className={styles.interfaceTitle}>{card.title}</h4>
                  <p className={styles.interfaceText}>{card.text}</p>

                </div>

              </article>

            ))}

          </div>

        </div>

      <Container>

        {/* Нижний блок со схемой */}
        <div className={styles.scheme}>

          <div className={styles.schemeInner}>
            
            {/* Выноски */}
            <div className={styles.callout + ' ' + styles.calloutLeftTop}>

              <div className={styles.calloutTitle}>Паровой цилиндр</div>

              <div className={styles.calloutText}>

                Эталонная электродная технология от мирового лидера, гарантирующая высочайшую надежность и чистоту пара

              </div>

            </div>

            <div className={styles.callout + ' ' + styles.calloutRightTop}>

              <div className={styles.calloutTitleRightTop}>Инновационное решение</div>

              <div className={styles.calloutTextRightTop}>

                Возможность одного паронерегатора работать на два независимых потребителя пара с контролем параметров в каждой зоне.

              </div> 

              <div className={styles.calloutDesc}>

                Дополнительный режим <br/> работы с резервированием гидравлического блока

              </div>

            </div>

            <div className={styles.callout + ' ' + styles.calloutRightBottom}>

              <div className={styles.calloutTitle}>Гидравлическая система</div>

              <div className={styles.calloutText}>

                Оснащена питательным и дренажным контурами для стабильной работы, защиты от накипи и максимального ресурса оборудования

              </div>

            </div>
            
          </div>

        </div>

      </Container>

    </section>

  );

};
