//! Source text to tokens.
//!
//! The lexer works on `char` indices rather than bytes, because Cog takes
//! identifiers and text in any script and a byte offset through Arabic source
//! points at the middle of a letter. Positions are counted in characters for
//! the same reason: an error caret has to land where the reader sees the
//! problem, not where the encoder happens to have put a continuation byte.
//!
//! Text is lexed into parts rather than a flat string. `"hello @user.name"` is
//! a literal followed by an interpolation, and the parser needs the position of
//! that interpolation to report an error inside it. `@@` is a literal at-sign
//! and must never be mistaken for the start of one, which is the single easiest
//! thing to get wrong in here.

use crate::keywords::is_hard_keyword;

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Number(f64),
    /// Seconds. A duration and a clock share one unit on purpose, so that
    /// comparing or adding them cannot silently mean two different things.
    Duration { seconds: f64, text: String },
    Clock { hours: u32, minutes: u32 },
    Text(Vec<Part>),
    Ident(String),
    Keyword(String),
    /// `@user`, `@channel` — the argument and any field chain are the parser's.
    Entity(String),
    Punct(char),
    Op(String),
    Eof,
}

/// A piece of a text literal: either characters, or something to work out.
#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Literal(String),
    /// A dotted path, kept as a path so `"@count"` does not run into the
    /// statement keyword of the same name.
    Path { path: String, line: u32, col: u32 },
    /// `@(…)` and `@channel("x").mention` — source to be parsed as an
    /// expression, with the `@` kept when it names an entity.
    Expr { source: String, line: u32, col: u32 },
}

#[derive(Debug, Clone)]
pub struct Token {
    pub tok: Tok,
    pub line: u32,
    pub col: u32,
}

pub struct LexError {
    pub message: String,
    pub hint: Option<String>,
    pub line: u32,
    pub col: u32,
    pub len: u32,
}

const PUNCT: &[char] = &['{', '}', '(', ')', '[', ']', ',', '.', ':'];
const DURATION_UNITS: &[char] = &['s', 'm', 'h', 'd', 'w'];

pub struct Lexer {
    src: Vec<char>,
    at: usize,
    line: u32,
    line_start: usize,
}

impl Lexer {
    pub fn new(source: &str) -> Self {
        Lexer { src: source.chars().collect(), at: 0, line: 1, line_start: 0 }
    }

    fn peek(&self) -> Option<char> {
        self.src.get(self.at).copied()
    }

    fn ahead(&self, n: usize) -> Option<char> {
        self.src.get(self.at + n).copied()
    }

    fn col(&self) -> u32 {
        (self.at - self.line_start + 1) as u32
    }

    fn newline(&mut self) {
        self.line += 1;
        self.at += 1;
        self.line_start = self.at;
    }

    fn fail<T>(&self, message: &str, hint: Option<&str>, len: u32) -> Result<T, LexError> {
        Err(LexError {
            message: message.to_string(),
            hint: hint.map(str::to_string),
            line: self.line,
            col: self.col(),
            len,
        })
    }

    /// A letter in any script, or an underscore.
    fn is_letter(c: char) -> bool {
        c == '_' || c.is_alphabetic()
    }

    fn is_ident_part(c: char) -> bool {
        Self::is_letter(c) || c.is_numeric()
    }

    pub fn run(mut self) -> Result<Vec<Token>, LexError> {
        let mut out = Vec::new();

        while self.at < self.src.len() {
            let c = self.src[self.at];

            if c == '\n' {
                self.newline();
                continue;
            }
            if c.is_whitespace() {
                self.at += 1;
                continue;
            }

            // A comment runs to the end of the line, and is checked before the
            // minus operator so `x --1` is a comment and not a subtraction.
            if c == '-' && self.ahead(1) == Some('-') {
                while self.at < self.src.len() && self.src[self.at] != '\n' {
                    self.at += 1;
                }
                continue;
            }

            let line = self.line;
            let col = self.col();

            if c.is_ascii_digit() {
                if let Some(tok) = self.clock()? {
                    out.push(Token { tok, line, col });
                    continue;
                }
                out.push(Token { tok: self.number()?, line, col });
                continue;
            }

            if c == '"' {
                out.push(Token { tok: self.text()?, line, col });
                continue;
            }

            if c == '@' {
                self.at += 1;
                match self.peek() {
                    Some(n) if Self::is_letter(n) => {}
                    _ => {
                        return self.fail(
                            "nothing follows this @",
                            Some("an entity is written @user, @channel(\"name\"), @made"),
                            1,
                        )
                    }
                }
                let mut name = String::new();
                while let Some(n) = self.peek() {
                    if !Self::is_ident_part(n) {
                        break;
                    }
                    name.push(n);
                    self.at += 1;
                }
                out.push(Token { tok: Tok::Entity(name), line, col });
                continue;
            }

            if Self::is_letter(c) {
                let mut word = String::new();
                while let Some(n) = self.peek() {
                    if !Self::is_ident_part(n) {
                        break;
                    }
                    word.push(n);
                    self.at += 1;
                }
                // Only the words that structure a program become keywords. The
                // contextual ones stay identifiers and the parser recognises
                // them where it expects them, which is what lets `carry count`
                // and `hold title` be ordinary names.
                let tok = if is_hard_keyword(&word) { Tok::Keyword(word) } else { Tok::Ident(word) };
                out.push(Token { tok, line, col });
                continue;
            }

            if PUNCT.contains(&c) {
                self.at += 1;
                out.push(Token { tok: Tok::Punct(c), line, col });
                continue;
            }

            // Operators, longest first so `<=` never lexes as `<` then `=`.
            let two: String = self.src[self.at..(self.at + 2).min(self.src.len())].iter().collect();
            if ["<=", ">=", "->"].contains(&two.as_str()) {
                self.at += 2;
                out.push(Token { tok: Tok::Op(two), line, col });
                continue;
            }
            if "+-*/%<>=".contains(c) {
                self.at += 1;
                out.push(Token { tok: Tok::Op(c.to_string()), line, col });
                continue;
            }

            return self.fail(&format!("{c:?} has no meaning here"), None, 1);
        }

        out.push(Token { tok: Tok::Eof, line: self.line, col: self.col() });
        Ok(out)
    }

    /// `00:03`, `9:30`. One or two digits for the hour, always two for minutes,
    /// checked before a number so `00:03` does not lex as `0`, `0`, `:`, `3`.
    fn clock(&mut self) -> Result<Option<Tok>, LexError> {
        let d = |c: Option<char>| c.is_some_and(|c| c.is_ascii_digit());

        let wide = d(self.ahead(1)) && self.ahead(2) == Some(':') && d(self.ahead(3)) && d(self.ahead(4));
        let narrow = self.ahead(1) == Some(':') && d(self.ahead(2)) && d(self.ahead(3)) && !d(self.ahead(4));
        if !wide && !narrow {
            return Ok(None);
        }

        let width = if wide { 5 } else { 4 };
        let raw: String = self.src[self.at..self.at + width].iter().collect();
        let (h, m) = raw.split_once(':').unwrap();
        let hours: u32 = h.parse().unwrap();
        let minutes: u32 = m.parse().unwrap();

        if hours > 23 || minutes > 59 {
            return self.fail(
                &format!("\"{raw}\" is not a clock time"),
                Some("hours are 0-23 and minutes are 00-59"),
                width as u32,
            );
        }
        self.at += width;
        Ok(Some(Tok::Clock { hours, minutes }))
    }

    fn number(&mut self) -> Result<Tok, LexError> {
        let mut raw = String::new();
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || c == '_' {
                raw.push(c);
                self.at += 1;
            } else {
                break;
            }
        }
        if self.peek() == Some('.') && self.ahead(1).is_some_and(|c| c.is_ascii_digit()) {
            raw.push('.');
            self.at += 1;
            while let Some(c) = self.peek() {
                if c.is_ascii_digit() || c == '_' {
                    raw.push(c);
                    self.at += 1;
                } else {
                    break;
                }
            }
        }

        // An exponent counts only with digits behind it, so `5e` stays a number
        // followed by a name rather than becoming half a literal.
        if matches!(self.peek(), Some('e') | Some('E')) {
            let signed = matches!(self.ahead(1), Some('+') | Some('-'));
            let digit_at = if signed { 2 } else { 1 };
            if self.ahead(digit_at).is_some_and(|c| c.is_ascii_digit()) {
                raw.push(self.src[self.at]);
                self.at += 1;
                if signed {
                    raw.push(self.src[self.at]);
                    self.at += 1;
                }
                while let Some(c) = self.peek() {
                    if c.is_ascii_digit() || c == '_' {
                        raw.push(c);
                        self.at += 1;
                    } else {
                        break;
                    }
                }
            }
        }

        let value: f64 = raw.replace('_', "").parse().unwrap_or(f64::NAN);

        // A unit only counts when nothing that could continue an identifier
        // follows it, so `5m` is a duration and `5monkeys` is an error worth
        // reporting rather than a silent `5` beside `monkeys`.
        if let Some(unit) = self.peek() {
            if DURATION_UNITS.contains(&unit) && !self.ahead(1).is_some_and(Self::is_ident_part) {
                self.at += 1;
                let per = match unit {
                    's' => 1.0,
                    'm' => 60.0,
                    'h' => 3600.0,
                    'd' => 86_400.0,
                    _ => 604_800.0,
                };
                return Ok(Tok::Duration { seconds: value * per, text: format!("{raw}{unit}") });
            }
        }
        Ok(Tok::Number(value))
    }

    fn text(&mut self) -> Result<Tok, LexError> {
        let start_line = self.line;
        let start_col = self.col();

        let block = self.ahead(1) == Some('"') && self.ahead(2) == Some('"');
        self.at += if block { 3 } else { 1 };

        // A block text starts on the line after its opening quotes, so that
        // first newline is layout and not content.
        if block && self.peek() == Some('\n') {
            self.newline();
        }

        let mut parts: Vec<Part> = Vec::new();
        let mut literal = String::new();

        macro_rules! flush {
            () => {
                if !literal.is_empty() {
                    parts.push(Part::Literal(std::mem::take(&mut literal)));
                }
            };
        }

        loop {
            let Some(c) = self.peek() else {
                return Err(LexError {
                    message: "this text is never closed".into(),
                    hint: Some(if block { "a block text ends with \"\"\"" } else { "a text ends with \"" }.into()),
                    line: start_line,
                    col: start_col,
                    len: 1,
                });
            };

            if block && c == '"' && self.ahead(1) == Some('"') && self.ahead(2) == Some('"') {
                self.at += 3;
                // The closing quotes sit on their own line, so the newline that
                // put them there is layout too.
                while literal.ends_with(' ') || literal.ends_with('\t') {
                    literal.pop();
                }
                if literal.ends_with('\n') {
                    literal.pop();
                }
                break;
            }
            if !block && c == '"' {
                self.at += 1;
                break;
            }
            if !block && c == '\n' {
                return Err(LexError {
                    message: "this text is never closed".into(),
                    hint: Some("use \"\"\" for text that spans lines".into()),
                    line: start_line,
                    col: start_col,
                    len: 1,
                });
            }

            if c == '\\' {
                let esc = self.ahead(1);
                let replacement = match esc {
                    Some('n') => '\n',
                    Some('r') => '\r',
                    Some('t') => '\t',
                    Some('"') => '"',
                    Some('\\') => '\\',
                    Some('@') => '@',
                    _ => {
                        return self.fail(
                            &format!("\\{} is not an escape", esc.unwrap_or(' ')),
                            Some("the escapes are \\n \\r \\t \\\" \\\\ \\@"),
                            2,
                        )
                    }
                };
                literal.push(replacement);
                self.at += 2;
                continue;
            }

            if c == '@' {
                // `@@` is a literal at-sign and not the start of anything.
                if self.ahead(1) == Some('@') {
                    literal.push('@');
                    self.at += 2;
                    continue;
                }

                let iline = self.line;
                let icol = self.col();
                self.at += 1;

                if self.peek() == Some('(') {
                    let from = self.at;
                    let mut depth = 0i32;
                    loop {
                        let Some(n) = self.peek() else {
                            return Err(LexError {
                                message: "this interpolation is never closed".into(),
                                hint: Some("a @( needs a matching )".into()),
                                line: iline,
                                col: icol,
                                len: 1,
                            });
                        };
                        match n {
                            '(' => depth += 1,
                            ')' => depth -= 1,
                            '\n' => {
                                self.newline();
                                continue;
                            }
                            _ => {}
                        }
                        self.at += 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    flush!();
                    let source: String = self.src[from + 1..self.at - 1].iter().collect();
                    parts.push(Part::Expr { source, line: iline, col: icol });
                    continue;
                }

                if !self.peek().is_some_and(Self::is_letter) {
                    return Err(LexError {
                        message: "nothing follows this @".into(),
                        hint: Some("write @name, @name.field or @(expression). For a literal at-sign, write @@".into()),
                        line: iline,
                        col: icol,
                        len: 1,
                    });
                }

                let mut path = String::new();
                let mut named = false;
                while let Some(n) = self.peek() {
                    if !Self::is_ident_part(n) {
                        break;
                    }
                    path.push(n);
                    self.at += 1;
                }

                // A named entity inside text: `@channel("welcome")`. The
                // parentheses are part of the interpolation, quotes and all, so
                // the quote inside does not end the text around it.
                if self.peek() == Some('(') {
                    let from = self.at;
                    let mut depth = 0i32;
                    loop {
                        let Some(n) = self.peek() else {
                            return Err(LexError {
                                message: "this interpolation is never closed".into(),
                                hint: Some("a ( inside text needs a matching )".into()),
                                line: iline,
                                col: icol,
                                len: 1,
                            });
                        };
                        match n {
                            '(' => depth += 1,
                            ')' => depth -= 1,
                            '\n' => {
                                self.newline();
                                continue;
                            }
                            _ => {}
                        }
                        self.at += 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    path.push_str(&self.src[from..self.at].iter().collect::<String>());
                    named = true;
                }

                while self.peek() == Some('.') && self.ahead(1).is_some_and(Self::is_letter) {
                    path.push('.');
                    self.at += 1;
                    while let Some(n) = self.peek() {
                        if !Self::is_ident_part(n) {
                            break;
                        }
                        path.push(n);
                        self.at += 1;
                    }
                }

                flush!();
                if named {
                    // The @ is kept, because what follows has to be read as an
                    // entity and not as a call to a verb of the same name.
                    parts.push(Part::Expr { source: format!("@{path}"), line: iline, col: icol });
                } else {
                    parts.push(Part::Path { path, line: iline, col: icol });
                }
                continue;
            }

            if c == '\n' {
                literal.push('\n');
                self.newline();
                continue;
            }

            literal.push(c);
            self.at += 1;
        }

        if !literal.is_empty() {
            parts.push(Part::Literal(literal));
        }
        Ok(Tok::Text(parts))
    }
}

/// What a token is, for an error message that has to name one.
pub fn describe(tok: &Tok) -> String {
    match tok {
        Tok::Number(n) => format!("the number {n}"),
        Tok::Duration { text, .. } => format!("the duration {text}"),
        Tok::Clock { hours, minutes } => format!("the time {hours:02}:{minutes:02}"),
        Tok::Text(_) => "text".into(),
        Tok::Ident(name) => format!("\"{name}\""),
        Tok::Keyword(word) => format!("the keyword \"{word}\""),
        Tok::Entity(name) => format!("@{name}"),
        Tok::Punct(c) => format!("\"{c}\""),
        Tok::Op(o) => format!("\"{o}\""),
        Tok::Eof => "the end of the file".into(),
    }
}
