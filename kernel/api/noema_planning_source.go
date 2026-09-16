package api

import (
	"net/http"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/noema/planning"
	"github.com/gin-gonic/gin"
)

// Native source computation only: paths, filesystem access, ID allocation and
// persistence remain with the source owner (including Remote workspaces).
func computeNoemaPlanningSource(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<20)
	var request struct {
		Content  string             `json:"content"`
		Selector planning.Selector  `json:"selector"`
		Mutation *planning.Mutation `json:"mutation,omitempty"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	if len(request.Content) > 16<<20 {
		ret.Code, ret.Msg = -1, "Agenda source exceeds 16 MiB"
		return
	}
	if request.Mutation == nil {
		ret.Data = map[string]interface{}{"nodes": planning.ScanDocument(request.Content, "")}
		return
	}
	result, err := planning.TransformSource(request.Content, request.Selector, *request.Mutation)
	if err != nil {
		ret.Code, ret.Msg = -1, err.Error()
		return
	}
	ret.Data = result
}
