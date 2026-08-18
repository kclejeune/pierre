'use client';

import { useStableCallback } from '@pierre/diffs/react';
import { IconX } from '@pierre/icons';
import { useRouter } from 'next/navigation';
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { createPortal } from 'react-dom';

import {
  type DiffUrlSuggestion,
  useDiffUrlSuggestions,
} from './useDiffUrlSuggestions';
import { Button } from '@/components/Button';
import { useGitHubEnvironment } from '@/components/GitHubEnvironmentProvider';
import { cn } from '@/lib/cn';
import { getPatchViewerHref } from '@/lib/getPatchViewerHref';

interface DiffUrlFormProps {
  className?: string;
  // When provided, the input restores to this value on blur or Escape. Also
  // controls the clear-button visibility: with an initialUrl set, the clear
  // button only shows when the input matches the committed URL or has an error
  // (i.e. not while the user is typing). Without an initialUrl the clear
  // button shows whenever the input has content.
  initialUrl?: string;
  inputClassName?: string;
  // Called whenever the controlled URL value changes, so parent components
  // can react to edits (e.g. to conditionally show/hide related controls).
  onUrlChange?: (url: string) => void;
  // Defaults to an example URL on the configured GitHub instance.
  placeholder?: string;
  // Render prop for the submit button area. Receives the transition pending
  // state and current URL value so callers can conditionally render controls.
  children?: (isPending: boolean, url: string) => ReactNode;
}

// Shared URL input form used in both the viewer header and the home page.
// Handles URL state, validation via getPatchViewerHref, router navigation,
// the validation error popover (portal-based to escape contain-paint), and
// escape/blur restore behavior.
export function DiffUrlForm({
  className,
  initialUrl = '',
  inputClassName,
  onUrlChange,
  placeholder,
  children,
}: DiffUrlFormProps) {
  const router = useRouter();
  const { host: githubHost, webURL: githubWebURL } = useGitHubEnvironment();
  const [isPending, startTransition] = useTransition();
  const [url, setURL] = useState(initialUrl);
  const [validationError, setValidationError] = useState<string | null>(null);
  // Keeps the error popover mounted while it fades out after the error clears.
  const [errorVisible, setErrorVisible] = useState(false);
  // Prevents the onBlur restore from firing when blur is caused by Enter.
  const isSubmittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Shorthand autocompletion: repo names while "owner/rep…" is typed, open
  // pull requests once a repo is complete. Only active while focused so the
  // dropdown never lingers after navigation.
  const [isFocused, setIsFocused] = useState(false);
  const suggestions = useDiffUrlSuggestions(isFocused ? url : '');
  // Highlighted row, remembered with the list it belongs to so a fresh
  // suggestion list naturally resets the highlight without an effect.
  const [activeEntry, setActiveEntry] = useState<{
    list: DiffUrlSuggestion[];
    index: number;
  } | null>(null);
  const activeSuggestion =
    activeEntry !== null && activeEntry.list === suggestions
      ? activeEntry.index
      : -1;
  const suggestionsOpen =
    isFocused && suggestions.length > 0 && validationError === null;

  // Both popovers (suggestions list, error message) are fixed-position portals
  // anchored under the input to escape contain-paint boundaries. One shared
  // measurement covers both; resize (including DevTools opening) and scroll
  // change the input's viewport position, so re-measure on those events.
  const anchorNeeded = suggestionsOpen || errorVisible;
  const [anchor, setAnchor] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    if (!anchorNeeded) {
      setAnchor(null);
      return;
    }
    const updatePosition = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (rect != null) {
        setAnchor({ left: rect.left, top: rect.bottom, width: rect.width });
      }
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorNeeded]);

  const acceptSuggestion = useStableCallback(
    (suggestion: DiffUrlSuggestion) => {
      setURL(suggestion.fill);
      setValidationError(null);
      // Pull suggestions fill a complete shorthand that resolves to a viewer
      // path; repo suggestions fill "owner/repo#", which doesn't resolve yet,
      // so keep focus for the pull-number pass.
      const viewerHref = getPatchViewerHref(suggestion.fill, githubHost);
      if (viewerHref != null) {
        isSubmittingRef.current = true;
        inputRef.current?.blur();
        startTransition(() => {
          router.push(viewerHref);
        });
      } else {
        inputRef.current?.focus();
      }
    }
  );

  useEffect(() => {
    setURL(initialUrl);
  }, [initialUrl]);

  useEffect(() => {
    onUrlChange?.(url);
  }, [onUrlChange, url]);

  const handleSubmit = useStableCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      isSubmittingRef.current = false;
      const normalizedURL = url.trim();
      const viewerHref = getPatchViewerHref(normalizedURL, githubHost);
      if (viewerHref == null) {
        setValidationError('Please enter a valid URL');
        setErrorVisible(true);
        return;
      }
      setValidationError(null);
      setURL(normalizedURL);
      startTransition(() => {
        router.push(viewerHref);
      });
    }
  );

  // Show the clear button when the input has content. When an initialUrl is
  // set (viewer header), hide it while the user is actively editing so it
  // doesn't distract — restore it once committed or on error.
  const showClear =
    url.length > 0 &&
    (initialUrl === '' || url === initialUrl || validationError !== null);

  return (
    <form
      className={cn(
        'group flex min-w-0 items-center gap-1 w-full overflow-hidden',
        className
      )}
      noValidate
      onSubmit={handleSubmit}
    >
      <input
        ref={inputRef}
        className={cn(
          'focus:text-primary block field-sizing-content h-9 min-w-[24ch] rounded-md text-sm focus-visible:outline-none',
          inputClassName
        )}
        enterKeyHint="go"
        value={url}
        // Plain text, not `type="url"`: the committed value is often the
        // `owner/repo#N` shorthand rather than a URL, and native URL
        // validation is not what decides acceptance (getPatchViewerHref is).
        type="text"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={suggestionsOpen}
        onChange={({ currentTarget }) => {
          setURL(currentTarget.value);
          if (validationError) setValidationError(null);
        }}
        onFocus={() => setIsFocused(true)}
        onBlur={() => {
          setIsFocused(false);
          if (isSubmittingRef.current) return;
          // Only restore the committed URL when the field is empty — if the
          // user typed something and clicked away, keep their draft.
          if (url.trim() === '') {
            setURL(initialUrl);
            setValidationError(null);
          }
        }}
        onKeyDown={(e) => {
          if (suggestionsOpen && e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveEntry({
              index: (activeSuggestion + 1) % suggestions.length,
              list: suggestions,
            });
            return;
          }
          if (suggestionsOpen && e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveEntry({
              index:
                (activeSuggestion - 1 + suggestions.length) %
                suggestions.length,
              list: suggestions,
            });
            return;
          }
          if (suggestionsOpen && e.key === 'Enter' && activeSuggestion >= 0) {
            e.preventDefault();
            acceptSuggestion(suggestions[activeSuggestion]);
            return;
          }
          if (e.key === 'Escape') {
            setURL(initialUrl);
            setValidationError(null);
            inputRef.current?.blur();
          } else if (e.key === 'Enter') {
            isSubmittingRef.current = true;
          }
        }}
        placeholder={placeholder ?? `${githubWebURL}/org/repo/123`}
      />
      {showClear && (
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          aria-label="Clear"
          className="opacity-0 transition-opacity duration-200 will-change-auto group-focus-within:opacity-50 group-hover:opacity-50 hover:opacity-75"
          onClick={() => {
            setURL('');
            setValidationError(null);
            inputRef.current?.focus();
          }}
        >
          <IconX className="size-4" />
        </Button>
      )}
      {children?.(isPending, url)}
      {/* Hidden submit ensures Enter triggers form submission in all browsers */}
      <button type="submit" hidden />
      {suggestionsOpen &&
        anchor !== null &&
        createPortal(
          <ul
            role="listbox"
            style={{
              left: anchor.left,
              minWidth: Math.max(anchor.width, 320),
              top: anchor.top + 6,
            }}
            className="bg-background border-border fixed z-50 max-h-80 max-w-[560px] overflow-y-auto rounded-md border py-1 shadow-lg"
          >
            {suggestions.map((suggestion, index) => (
              <li key={suggestion.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeSuggestion}
                  className={cn(
                    'block w-full cursor-pointer truncate px-3 py-1.5 text-left text-sm',
                    index === activeSuggestion && 'bg-muted'
                  )}
                  // preventDefault keeps focus in the input so the blur
                  // handler doesn't close the list before click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => acceptSuggestion(suggestion)}
                  onMouseEnter={() =>
                    setActiveEntry({ index, list: suggestions })
                  }
                >
                  {suggestion.label}
                </button>
              </li>
            ))}
          </ul>,
          document.body
        )}
      {errorVisible &&
        anchor !== null &&
        createPortal(
          <div
            aria-live="polite"
            style={{ top: anchor.top + 8, left: anchor.left }}
            className={cn(
              'bg-foreground text-background pointer-events-none fixed z-50 rounded-md px-3 py-1.5 text-xs transition-opacity duration-150',
              validationError !== null ? 'opacity-100' : 'opacity-0'
            )}
            onTransitionEnd={() => {
              if (validationError === null) setErrorVisible(false);
            }}
          >
            <div className="bg-foreground absolute -top-1 left-3 size-2.5 rotate-45 rounded-[2px]" />
            Please enter a valid URL
          </div>,
          document.body
        )}
    </form>
  );
}
