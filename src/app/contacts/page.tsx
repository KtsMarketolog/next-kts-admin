'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import styles from './ContactsPage.module.scss';
import { useSiteSettings } from '@/shared/lib/useSiteSettings';
import Container from '@/shared/ui/Container';

function CitySelectSkeleton() {
  return <div className={styles.fieldSkeleton} aria-hidden="true" />;
}

function PhoneInputSkeleton() {
  return (
    <div className={styles.phoneSkeleton} aria-hidden="true">
      <span className={styles.phoneSkeletonCode} />
      <span className={styles.phoneSkeletonNumber} />
    </div>
  );
}

const PhoneInput = dynamic(() => import('@/shared/ui/PhoneInput/PhoneInput'), {
  ssr: false,
  loading: () => <PhoneInputSkeleton />,
});

const CitySelect = dynamic(() => import('@/shared/ui/CitySelect/CitySelect'), {
  ssr: false,
  loading: () => <CitySelectSkeleton />,
});

function splitAddress(address: string) {
  const normalized = address.trim();
  const explicitLines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (explicitLines.length > 1) return explicitLines;

  const commaIndex = normalized.indexOf(',');
  if (commaIndex === -1) return normalized ? [normalized] : [];

  return [normalized.slice(0, commaIndex + 1).trim(), normalized.slice(commaIndex + 1).trim()].filter(Boolean);
}

export default function ContactsPage() {

  const { phone, email, address } = useSiteSettings();
  const addressLines = splitAddress(address);

  const [isHuman, setIsHuman] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [selectedCity, setSelectedCity] = useState('');

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [popupMessage, setPopupMessage] = useState('');
  const [isPopupOpen, setIsPopupOpen] = useState(false);

  const showPopup = (message: string) => {

    setPopupMessage(message);
    setIsPopupOpen(true);

  };
  

  useEffect(() => {

    if (file && file.type.startsWith('image/')) {

      const url = URL.createObjectURL(file);

      setPreviewUrl(url);

      return () => URL.revokeObjectURL(url);

    }

    setPreviewUrl(null);
    
  }, [file]);

  const SIZE_LIMIT = 10 * 1024 * 1024; 

  const onFileChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {

    const f = e.currentTarget.files?.[0] || null;

    if (!f) {

      setFile(null);
      return;

    }

    if (f.size > SIZE_LIMIT) {

      showPopup('Файл слишком большой (максимум 10 МБ).');

      if (fileInputRef.current) fileInputRef.current.value = '';

      setFile(null);

      return;

    }

    setFile(f);

  };

  const clearFile = () => {

    if (fileInputRef.current) fileInputRef.current.value = '';
    setFile(null);

  };

  const handleSubmit = async (e: React.FormEvent) => {

    e.preventDefault();

    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);

    formData.set('city', selectedCity || '');

    if (!purpose) {

      showPopup('Пожалуйста, выберите цель обращения.');
      return;

    }

    const requiredFields = ['company', 'city', 'contact', 'email'];

    for (const field of requiredFields) {

      if (!(formData.get(field) as string)?.trim()) {

        showPopup('Пожалуйста, заполните все поля.');
        return;

      }

    }

    const email = formData.get('email') as string;
    const rawPhone = (formData.get('phone') as string || '').trim();
    const phoneDigits = rawPhone.replace(/\D/g, ''); 

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {

      showPopup('Введите корректный email.');
      return;

    }

    if (phoneDigits.length > 0) {

      if (phoneDigits.length < 8) {

        showPopup('Введите корректный номер телефона.');
        return;

      }

    }

    if (!isHuman) {

      showPopup('Пожалуйста, подтвердите, что вы не робот.');
      return;

    }

    const res = await fetch('/api/send-partner-request', {

      method: 'POST',
      body: formData,

    });

    const json = await res.json().catch(() => null);

    if (!res.ok || !json?.ok) {

      showPopup('Ошибка отправки. Проверьте данные и попробуйте ещё раз.');
      return;

    }

    showPopup('Заявка отправлена!');
    form.reset();
    setIsHuman(false);
    setPurpose('');
    setSelectedCity('');
    setFile(null);
    
  };

  const prettySize = (bytes: number) =>
    bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
      : `${(bytes / 1024).toFixed(1)} КБ`;

  const isResume = purpose === 'Направить резюме';

  return (

    <>
      <div className={styles.contactPadding}></div>

      <div className={styles.contactBg}>

        <Container>

          <div className={styles.contactGrid}>

            <div className={styles.formBlock}>

              <h1>Оставьте заявку</h1>

              <form onSubmit={handleSubmit} suppressHydrationWarning>

                <p className={styles.sectionTitle}>Что бы вы хотели *</p>


                <div className={styles.purposeButtons}>

                  {['Направить резюме', 'Получить КП', 'Проконсультироваться', 'Стать дилером'].map((label) => (

                    <button

                      key={label}
                      type="button"
                      className={`${styles.purposeBtn} ${purpose === label ? styles.active : ''}`}
                      onClick={() => setPurpose(label)}

                    >

                      {label}

                    </button>

                  ))}

                </div>

                <div className={styles.formInputs}>

                  <div className={styles.floating}>

                    <input name="company" placeholder=" " required />
                    <label>{isResume ? 'Имя' : 'Название организации *'}</label>

                  </div>

                  <div className={styles.floating}>

                    <CitySelect value={selectedCity} onChange={setSelectedCity} />
                    <input type="hidden" name="city" value={selectedCity} />

                  </div>

                  <div className={styles.floating}>

                    <input name="contact" placeholder=" " required />
                    <label>{isResume ? 'Вакансия' : 'Контактное лицо *'}</label>

                  </div>

                  <div className={styles.floating} style={{ background: 'none', width: 'auto' }}>

                    <PhoneInput

                      name="phone"    
                      required={false}    
                      onChange={() => {

                      }}

                    />

                  </div>

                  <div className={styles.floating}>

                    <input type="email" name="email" placeholder=" " required />

                    <label className={styles.labelWithIcon}>

                      <img src="/img/form/email.svg" alt="" />
                      
                      Enter your email *

                    </label>

                  </div>

                </div>

                <input type="hidden" name="purpose" value={purpose} />

                <label className={styles.fileAttach}>

                  <img src="/img/clip.svg" alt="скрепка" />

                  <span>{isResume ? 'Прикрепить резюме' : 'Прикрепить файл'}</span>

                  <input

                    ref={fileInputRef}
                    type="file"
                    name="file"
                    onChange={onFileChange}
                    accept={purpose === 'Направить резюме' ? '.pdf,.doc,.docx,.rtf' : undefined}

                  />

                </label>

                {file && (

                  <div className={styles.fileBadge} aria-live="polite">

                    <div className={styles.fileMeta}>

                      <span className={styles.fileName}>{file.name}</span>

                      <span className={styles.fileSize}> · {prettySize(file.size)}</span>

                    </div>

                    <div className={styles.fileActions}>

                      {previewUrl && (

                        <a href={previewUrl} target="_blank" rel="noopener noreferrer" className={styles.filePreview}>Просмотр</a>

                      )}

                      <button type="button" onClick={clearFile} className={styles.fileRemove}>Удалить</button>

                    </div>

                  </div>

                )}

                <div className={styles.floating}>
                  
                  <textarea name="comment" placeholder=" " />
                  <label>{isResume ? 'Сопроводительное письмо' : 'Комментарии'}</label>

                </div>

                <label className={styles.checkbox}>

                  <input

                    type="checkbox"
                    id="not-robot"
                    name="notRobot"
                    checked={isHuman}
                    onChange={(e) => setIsHuman(e.target.checked)}

                  />

                  <span className={styles.customCheckbox}></span>
                  <span className={styles.testCheckbox}>Я не робот *</span>

                </label>

                <button type="submit">Отправить</button>

              </form>

            </div>

            <div className={styles.infoBlock}>

              <h3>Связаться с нами</h3>

              <div className={styles.contactIntro}>

                <img src="/img/email-contacts.png" alt="Email Icon" className={styles.icon} />

                <p>

                  Каждое обращение мы рассматриваем индивидуально. Погружаемся в суть задачи и предлагаем конкретное,
                  рабочее решение - с учетом ваших целей, сроков и специфики бизнеса. Отвечаем быстро и по существу

                </p>

              </div>

              <div className={styles.contacts}>

                <p className={styles.contactPhone}>{phone}</p>

                {addressLines[0] && <p className={styles.contactRegion}>{addressLines[0]}</p>}

                <p className={styles.contactEmail}><a href={`mailto:${email}`}>{email}</a></p>

                {addressLines.slice(1).map((line) => (
                  <p className={styles.contactAddressLine} key={line}>{line}</p>
                ))}

              </div>


              <div className={styles.mapWrap}>
                
                <iframe
                  src="https://yandex.ru/map-widget/v1/?ll=48.352449%2C55.901259&mode=search&ol=geo&ouri=ymapsbm1%3A%2F%2Fgeo%3Fdata%3DCgoxNTEyNDg1OTgxEmDQoNC-0YHRgdC40Y8sINCg0LXRgdC_0YPQsdC70LjQutCwINCc0LDRgNC40Lkg0K3Quywg0JLQvtC70LbRgdC6LCDRg9C70LjRhtCwINCc0LDQvNCw0YHQtdCy0L4sIDEiCg3paEFCFeOaX0I%2C&z=17.2"
                ></iframe>

              </div>

            </div>

          </div>

        </Container>

      </div>

      {isPopupOpen && (

        <div className={styles.popupOverlay}>

          <div className={styles.popup}>

            <p>{popupMessage}</p>

            <button onClick={() => setIsPopupOpen(false)}>Закрыть</button>

          </div>

        </div>

      )}

    </>

  );
  
}
