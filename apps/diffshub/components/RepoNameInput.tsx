'use client';

import { useEffect, useState } from 'react';

import { Button } from './Button';
import { Input } from './Input';
import {
  type DiffUrlSuggestion,
  loadSuggestions,
} from './useDiffUrlSuggestions';
import { isValidRepoName } from '@/lib/pinnedRepos';

// Free-text "owner/name" input with live GitHub repo-name suggestions,
// sharing the URL bar's suggestion loader (and its cache). Used by the
// /pulls dashboard to pin repositories and by /browse to pick one.
export function RepoNameInput({
  onSubmit,
  placeholder,
  submitLabel,
}: {
  onSubmit: (repo: string) => void;
  placeholder: string;
  submitLabel: string;
}) {
  const [value, setValue] = useState('');
  const [suggestions, setSuggestions] = useState<DiffUrlSuggestion[]>([]);

  useEffect(() => {
    const query = value.trim();
    if (query === '' || isValidRepoName(query)) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const slash = query.indexOf('/');
      void loadSuggestions(
        slash === -1
          ? { kind: 'repos', owner: null, query }
          : {
              kind: 'repos',
              owner: query.slice(0, slash),
              query: query.slice(slash + 1),
            }
      ).then((items) => {
        if (!cancelled) {
          setSuggestions(items.slice(0, 5));
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  const submit = (repo: string) => {
    if (isValidRepoName(repo)) {
      onSubmit(repo);
      setValue('');
      setSuggestions([]);
    }
  };

  return (
    <div className="space-y-1">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit(value.trim());
        }}
      >
        <Input
          inputSize="sm"
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={!isValidRepoName(value.trim())}
        >
          {submitLabel}
        </Button>
      </form>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion.key}
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => submit(suggestion.label)}
            >
              {suggestion.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
