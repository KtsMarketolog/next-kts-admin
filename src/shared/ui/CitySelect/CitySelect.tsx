'use client';

import { useEffect, useMemo, useState } from 'react';
import CreatableSelect from 'react-select/creatable';
import type { SingleValue, ActionMeta } from 'react-select';
import { customSelectStyles } from './SelectStyles';
import styles from './CitySelect.module.scss';

type OptionType = { value: string; label: string };

type Props = {

  onChange: (value: string) => void;

  value?: string;

};

export default function CitySelect({ onChange, value }: Props) {

  const [options, setOptions] = useState<OptionType[]>([]);
  const [isFocused, setIsFocused] = useState(false);
  const [inputValue, setInputValue] = useState('');

  // Подгружаем города
  useEffect(() => {

    let alive = true;

    fetch('/data/cities.json')

      .then((r) => r.json())
      .then((cities: string[]) => {

        if (!alive) return;

        setOptions(cities.map((c) => ({ value: c, label: c })));

      })

      .catch(() => {});

    return () => {

      alive = false;

    };

  }, []);

  // Текущее selectedOption (поддержка кастомного города)
  const selectedOption: OptionType | null = useMemo(() => {

    if (!value) return null;

    return options.find((o) => o.value === value) ?? { value, label: value };

  }, [options, value]);

  // Когда выбрали из меню — пишем наверх и чистим строку поиска
  const handleChange = (
    
    selected: SingleValue<OptionType>,
    _meta: ActionMeta<OptionType>

  ) => {

    onChange(selected?.value || '');
    setInputValue('');
    
  };

  // Создание кастомного города
  const handleCreate = (createdLabel: string) => {

    const v = createdLabel.trim();
    if (!v) return;
    const newOption = { value: v, label: v };
    
    setOptions((prev) => {

      if (prev.some((o) => o.value.toLowerCase() === v.toLowerCase())) return prev;
      return [...prev, newOption];

    });

    onChange(v);
    setInputValue('');

  };

  // Если юзер ушёл из поля с набранным текстом — коммитим
  const handleBlur = () => {

    setIsFocused(false);
    commitInputIfAny();

  };

  // Очищаем строку поиска когда значение уже выбрано извне
  useEffect(() => {

    if (value) setInputValue('');

  }, [value]);

  useEffect(() => {

    if (!inputValue || isFocused) return;
    commitInputIfAny();

  }, [inputValue, isFocused, options]);

  const commitInputIfAny = () => {

    const draft = inputValue.trim();

    if (!draft) return;

    const match = options.find(

      (o) => o.label.toLowerCase() === draft.toLowerCase()

    );

    if (match) {

      onChange(match.value);

      setInputValue('');

    } else {

      handleCreate(draft);

    }

  };

  return (

    <div className={`${styles.floating} ${isFocused || !!value ? styles.focused : ''}`}>

      <CreatableSelect<OptionType, false>
        classNamePrefix="react-select"
        styles={customSelectStyles}
        placeholder=""
        isSearchable
        isClearable
        options={options}
        value={selectedOption}
        inputValue={inputValue}
        onInputChange={(val) => setInputValue(val)}
        onChange={handleChange}
        onCreateOption={handleCreate}
        onFocus={() => setIsFocused(true)}
        onBlur={handleBlur}
        formatCreateLabel={(input) => `Добавить: «${input}»`}
        menuShouldScrollIntoView
        blurInputOnSelect

      />

      <label>Город *</label>

    </div>

  );

}