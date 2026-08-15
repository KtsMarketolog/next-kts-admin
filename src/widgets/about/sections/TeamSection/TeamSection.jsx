import styles from './TeamSection.module.scss';

const subLeaders = [

  {

    img: '/img/people/zaynullin-ilnaz.png',
    name: 'Зайнуллин Ильназ',
    role: 'Директор по развитию',

  },

  {
    img: '/img/people/safronov-denis.png',
    name: 'Сафронов Денис',
    role: 'Руководитель направления Заводы',
  },

  {

    img: '/img/people/gafas-asil.png',
    name: 'Гафас Асыл',
    role: 'Директор по продажам',

  },

];

const experts = [

  {

    img: '/img/people/hasanov-ramil.png',
    name: 'Хасанов Рамиль',
    tags: ['Эксперт', 'Линейная автоматика'],
    phone: '8 963 127 55 32',
    email: 'product1@kts-impex.ru',

  },

  {

    img: '/img/people/garilyuk-aleksandr.png',
    name: 'Гаврилюк Александр',
    tags: ['Эксперт', 'Электронные компоненты'],
    phone: '8 906 335 65 05',
    email: 'alexander.gavrilyuk@rosholod-impex.ru',

  },

  {

    img: '/img/people/tkach-konstantin.png',
    name: 'Ткач Константин',
    tags: ['Эксперт', 'Теплообменное оборудование', 'Готовое холодильное оборудование'],
    phone: '8 967 755 67 14',
    email: 'tkach.k@kts-impex.ru',

  },

  {

    img: '/img/people/bugera-yuriy.png',
    name: 'Бугера Юрий',
    tags: ['Эксперт', 'Спиральные компрессора'],
    phone: '8 916 810 90 98',
    email: 'bugera@kts-impex.ru',

  },

];

export const TeamSection = () => {

  return (

    <section className={styles.teamSection} id="team">

      <div className={styles.bgGradient}>
        
          <div className={styles.content}>

            <h2 className={styles.title}>

              Команда/<span>Руководство</span>

            </h2>

            {/* ТОП-ЛИДЕР */}
            {/* <div className={styles.topLeader}>

              <div className={styles.mainCard}>

                <img src={topLeader.img} alt={topLeader.name} />

                <div className={styles.info}>

                  <div className={styles.left}>

                    <h3>{topLeader.name}</h3>

                    <p>{topLeader.description}</p>

                  </div>

                  <div className={styles.right}>

                    <ul className={styles.tags}>

                      {topLeader.tags.map((tag, index) => (

                        <li key={index}>{tag}</li>

                      ))}

                    </ul>

                  </div>

                </div>

              </div>

            </div> */}

            {/* РУКОВОДИТЕЛИ */}
            <div className={styles.subLeaders}>

              {subLeaders.map((leader, index) => (

                <div className={styles.card} key={index}>

                  <img src={leader.img} alt={leader.name} />

                  <p className={styles.name}>{leader.name}</p>

                  <p className={styles.role}>{leader.role}</p>

                </div>

              ))}

            </div>

            <h2 className={styles.title}>

              Команда/<span>Технические эксперты</span>

            </h2>

            {/* ЭКСПЕРТЫ */}
            <div className={styles.experts}>

              {experts.map((expert, index) => (

                <div className={styles.expertCard} key={index}>


                  <img src={expert.img} alt={expert.name} />

                  <div className={styles.nameAndTags}>

                    <p className={styles.name}>{expert.name}</p>

                    <div className={styles.tagsRow}>

                      {expert.tags.map((tag, i) => (

                        <span key={i}>{tag}</span>

                      ))}

                    </div>

                  </div>

                  {/* <div className={styles.info}>

                    <p className={styles.phone}>{expert.phone}</p>
                    <p className={styles.email}>{expert.email}</p>

                  </div> */}

                </div>

              ))}

            </div>

          </div>

      </div>

    </section>

  );

};
