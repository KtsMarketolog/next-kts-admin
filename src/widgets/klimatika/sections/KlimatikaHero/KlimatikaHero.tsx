import Container from '@/shared/ui/Container';
import styles from "./KlimatikaHero.module.scss";

export const KlimatikaHero = () => {

  return (

    <Container>

      <div className={styles.pad} />

      <div className={styles.bg}>

        <section className={styles.hero}>

          <h1 className={styles.title}>

            Паровые увлажнители

            <br />

            воздуха Uniray

          </h1>

        </section>

      </div>

    </Container>

  );

};