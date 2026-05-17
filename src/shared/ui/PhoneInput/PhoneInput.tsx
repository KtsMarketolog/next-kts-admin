'use client';

import { useMemo, useState, useEffect } from 'react';
import Select, { SingleValue } from 'react-select';
import styles from './PhoneInput.module.scss';

type CountryOption = {
  dial: string;
  label: string; 
  value: string; 
};

type Props = {

  value?: string;
  onChange: (fullPhone: string) => void;
  placeholder?: string;
  disabled?: boolean;
  name?: string;
  required?: boolean;

};

const COUNTRY_OPTIONS: CountryOption[] = [

  { dial: '+7',   label: '+7',    value: 'ru' },
  { dial: '+375', label: '+375',  value: 'by' },
  { dial: '+374', label: '+374',  value: 'am' },
  { dial: '+996', label: '+996',  value: 'kg' },
  { dial: '+998', label: '+998',  value: 'uz' },
  { dial: '+380', label: '+380',  value: 'ua' },

];

const onlyDigits = (s: string) => s.replace(/\D+/g, '');
const parseLocal = (s: string) => onlyDigits(s).slice(0, 10);
function formatLocal(digits: string) {

  const d = onlyDigits(digits).slice(0, 10);
  const p1 = d.slice(0, 3);
  const p2 = d.slice(3, 6);
  const p3 = d.slice(6, 8);
  const p4 = d.slice(8, 10);
  if (!d) return '';
  if (d.length <= 3) return `(${p1}`;
  if (d.length <= 6) return `(${p1}) ${p2}`;
  if (d.length <= 8) return `(${p1}) ${p2} ${p3}`;
  return `(${p1}) ${p2} ${p3} ${p4}`;

}

export default function PhoneInput({

  value,
  onChange,
  placeholder = '(999) 888 77 55',
  disabled,
  name,
  required,

}: Props) {

  const initial = useMemo(() => {

    if (!value) return { dial: '+7', local: '' };

    const dial = COUNTRY_OPTIONS

      .map((o) => o.dial)
      .sort((a, b) => b.length - a.length)
      .find((d) => value.startsWith(d));

    if (!dial) return { dial: '+7', local: onlyDigits(value) };

    return { dial, local: onlyDigits(value.slice(dial.length)) };

  }, [value]);

  const [country, setCountry] = useState<CountryOption>(

    COUNTRY_OPTIONS.find((o) => o.dial === initial.dial) || COUNTRY_OPTIONS[0]

  );

  const [localDigits, setLocalDigits] = useState(initial.local);

  // синхрон снаружи
  useEffect(() => {

    setCountry(COUNTRY_OPTIONS.find((o) => o.dial === initial.dial) || COUNTRY_OPTIONS[0]);
    setLocalDigits(initial.local);

  }, [initial.dial, initial.local]);

  // эмит наверх
  const fullPhone = useMemo(() => `${country.dial} ${localDigits}`.trim(), [country.dial, localDigits]);

  useEffect(() => {

    onChange(fullPhone);

  }, [fullPhone, onChange]);

  const onCountryChange = (opt: SingleValue<CountryOption>) => { if (opt) setCountry(opt); };
  const onLocalChange: React.ChangeEventHandler<HTMLInputElement> = (e) => setLocalDigits(parseLocal(e.target.value));
  const hiddenValue = localDigits ? `${country.dial} ${localDigits}` : '';
  

  return (

    <div className={styles.phoneGroup} aria-disabled={disabled} aria-required={required}>

      <Select<CountryOption, false>

        classNamePrefix="rp"
        instanceId="phone-country"
        inputId="phone-country-input"
        isSearchable={false}
        isClearable={false}
        isDisabled={disabled}
        options={COUNTRY_OPTIONS}
        value={country}
        onChange={onCountryChange}
        styles={{

          control: (base, s) => ({
            ...base,
            minHeight: 'unset',
            height: '100%',
            backgroundColor: '#303639',
            borderRadius: 16,
            borderColor: s.isFocused ? '#a082dc' : 'rgba(160,130,220,.3)',
            boxShadow: s.isFocused ? '0 0 0 3px rgba(160,130,220,.25)' : 'none',
            ':hover': { borderColor: 'rgba(160,130,220,.5)' },
            
          }),

          valueContainer: (b) => ({ ...b, padding: '0 12px' }),
          indicatorsContainer: (b) => ({ ...b, paddingRight: 8 }),
          menu: (b) => ({ ...b, backgroundColor: '#303639', borderRadius: 12, overflow: 'hidden', zIndex: 20 }),
          option: (b, s) => ({ ...b, backgroundColor: s.isFocused ? '#3f4650' : 'transparent', color: '#B1B1B1' }),
          singleValue: (b) => ({ ...b, color: '#B1B1B1' }),

        }}

      />

      <div className={styles.local}>

        <input
        
          type="text"
          inputMode="numeric"
          autoComplete="tel"
          disabled={disabled}
          placeholder={placeholder}
          value={formatLocal(localDigits)}
          onChange={onLocalChange}

        />

      </div>

        {name && (

          <input

            type="hidden"
            name={name}
            value={hiddenValue}
            required={false}
            readOnly

          />

        )}

    </div>

  );

}
