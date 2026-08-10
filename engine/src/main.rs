//! The cog command.
//!
//! This is the real implementation: a binary with its own engine. Nothing here
//! stands on another language's runtime, and the JavaScript tree beside it is a
//! reference to be compared against until it is retired, not a dependency.
//!
//! Building out in the order a language actually needs: tokens, then a syntax
//! tree, then bytecode, then the machine that runs it. Each stage is finished
//! and checked against the reference before the next one starts, because a
//! compiler whose front end is wrong produces a back end nobody can debug.

mod keywords;
mod lex;

use std::process::ExitCode;

const USAGE: &str = "\
cog — an agent-oriented language

  cog tokens <file>   print the token stream
  cog run <file>      execute a program
  cog build <file>    lower the agent layer onto a host runtime
  cog check <file>    parse and report problems, changing nothing
  cog version         what this binary is
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        print!("{USAGE}");
        return ExitCode::from(1);
    };

    match command {
        "help" | "--help" | "-h" => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        "version" | "--version" => {
            println!("cog {} ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH);
            ExitCode::SUCCESS
        }
        "tokens" => run_over(&args[1..], tokens),
        "run" | "build" | "check" => {
            eprintln!("`cog {command}` is not in this binary yet.");
            eprintln!("The engine is being written in the order a language needs: tokens are done.");
            ExitCode::from(2)
        }
        other => {
            eprintln!("unknown command \"{other}\"\n");
            print!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn run_over(files: &[String], each: fn(&str, &str) -> Result<(), String>) -> ExitCode {
    if files.is_empty() {
        eprintln!("that needs a file.\n");
        print!("{USAGE}");
        return ExitCode::from(2);
    }
    let mut failed = 0;
    for name in files {
        match std::fs::read_to_string(name) {
            Ok(source) => {
                if let Err(report) = each(name, &source) {
                    eprintln!("{report}");
                    failed += 1;
                }
            }
            Err(problem) => {
                eprintln!("cannot read {name}: {problem}");
                failed += 1;
            }
        }
    }
    if failed > 0 { ExitCode::from(1) } else { ExitCode::SUCCESS }
}

fn tokens(name: &str, source: &str) -> Result<(), String> {
    match lex::Lexer::new(source).run() {
        Ok(tokens) => {
            for token in &tokens {
                println!("{:>4}:{:<4} {}", token.line, token.col, describe_for_dump(&token.tok));
            }
            Ok(())
        }
        Err(problem) => Err(report(name, source, &problem)),
    }
}

/// One line per token, in a shape that can be diffed against the reference.
fn describe_for_dump(tok: &lex::Tok) -> String {
    use lex::{Part, Tok};
    match tok {
        Tok::Number(n) => format!("number    {n}"),
        Tok::Duration { seconds, text } => format!("duration  {text} ({seconds}s)"),
        Tok::Clock { hours, minutes } => format!("clock     {hours:02}:{minutes:02}"),
        Tok::Ident(name) => format!("ident     {name}"),
        Tok::Keyword(word) => format!("keyword   {word}"),
        Tok::Entity(name) => format!("entity    @{name}"),
        Tok::Punct(c) => format!("punct     {c}"),
        Tok::Op(o) => format!("op        {o}"),
        Tok::Eof => "eof".to_string(),
        Tok::Text(parts) => {
            let inner: Vec<String> = parts
                .iter()
                .map(|p| match p {
                    Part::Literal(text) => format!("{text:?}"),
                    Part::Path { path, .. } => format!("@{path}"),
                    Part::Expr { source, .. } => format!("@({source})"),
                })
                .collect();
            format!("text      [{}]", inner.join(", "))
        }
    }
}

/// An error with the line it happened on and a caret under the column.
///
/// This matters more in a compiler than almost anything else in it. A message
/// without a position makes the reader search; a caret in the wrong column
/// makes them search somewhere wrong, which is worse.
fn report(file: &str, source: &str, problem: &lex::LexError) -> String {
    let line_text = source.lines().nth(problem.line as usize - 1).unwrap_or("");
    let number = problem.line.to_string();
    let gutter = " ".repeat(number.len());

    let mut out = format!(
        "{file}:{}:{}  {}\n{gutter} |\n{number} | {line_text}\n{gutter} | ",
        problem.line, problem.col, problem.message
    );
    // Count in characters, not bytes: the caret has to land under the letter
    // the reader sees, and Arabic source makes the two disagree.
    out.push_str(&" ".repeat(problem.col.saturating_sub(1) as usize));
    out.push_str(&"^".repeat(problem.len.max(1) as usize));
    if let Some(hint) = &problem.hint {
        out.push_str(&format!("\n{gutter} |\n{gutter} = {hint}"));
    }
    out
}
