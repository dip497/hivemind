//! What was drawn on the board of a workspace on the computer (spec/workspace-api.md, `board.*`):
//! the phone lists the drawings and is sent a picture of one to look at. Drawing is the computer's.

use anyhow::{anyhow, Result};
use iroh::endpoint::Connection;
use serde::Serialize;
use serde_json::{json, Value};

use crate::workspace::Workspace;

/// A drawing as the phone lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Drawing {
    pub id: String,
    pub title: String,
    /// The tile of the agent that drew it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    pub objects: u64,
}

/// The drawings of a board, as `board.read` gives them.
pub fn read_drawings(reading: &Value) -> Vec<Drawing> {
    reading
        .get("drawings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|d| {
            Some(Drawing {
                id: d.get("id")?.as_str()?.to_owned(),
                title: d
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                by: d.get("by").and_then(Value::as_str).map(str::to_owned),
                objects: d.get("objects").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect()
}

/// What was drawn on the board of `workspace`.
pub async fn drawings(connection: &Connection, workspace: &str) -> Result<Vec<Drawing>> {
    let mut w = Workspace::open(connection, workspace).await?;
    let reading = w
        .call(
            "board.read",
            json!([format!("hive://{workspace}"), { "limit": 0 }]),
        )
        .await?;
    Ok(read_drawings(&reading))
}

/// A picture of the drawing `id`, or of all that is drawn, as an SVG.
pub async fn picture(
    connection: &Connection,
    workspace: &str,
    id: Option<&str>,
    theme: &str,
) -> Result<String> {
    let mut w = Workspace::open(connection, workspace).await?;
    let ask = match id {
        Some(id) => json!({ "drawing": id, "theme": theme }),
        None => json!({ "theme": theme }),
    };
    let answer = w
        .call("board.picture", json!([format!("hive://{workspace}"), ask]))
        .await?;
    answer
        .get("svg")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("the computer sent no picture"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drawing_is_listed_by_its_title_and_who_drew_it_and_one_with_no_id_is_left_out() {
        let reading = json!({
            "drawings": [
                { "id": "d1", "title": "Login flow", "by": "tile-1", "objects": 6, "box": { "x": 0 } },
                { "id": "d2", "title": "", "objects": 1 },
                { "title": "no id" },
            ],
        });
        assert_eq!(
            read_drawings(&reading),
            vec![
                Drawing {
                    id: "d1".into(),
                    title: "Login flow".into(),
                    by: Some("tile-1".into()),
                    objects: 6
                },
                Drawing {
                    id: "d2".into(),
                    title: String::new(),
                    by: None,
                    objects: 1
                },
            ]
        );
    }
}
